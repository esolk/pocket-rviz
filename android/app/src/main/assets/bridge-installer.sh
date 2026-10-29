#!/usr/bin/env bash
# MIT. Fixed, user-approved operations. Credentials only arrive on stdin for sudo.
set -euo pipefail
umask 077
MODE=${1:-probe}
TOKEN=${2:-}
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
case "$MODE" in probe|plan|install|start) ;; *) fail 'Unsupported operation';; esac
[[ $(id -u) != 0 ]] || fail 'Use a normal SSH user, not root.'
[[ -f /etc/os-release ]] || fail 'Cannot identify host OS.'
. /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 20.04 ]] || fail 'Only Ubuntu 20.04 + ROS Noetic is supported; no changes made.'
ARCH=$(dpkg --print-architecture)
case "$ARCH" in amd64|arm64) ;; *) fail 'Only amd64 and arm64 are supported.';; esac
[[ -f /opt/ros/noetic/setup.bash ]] || fail 'ROS Noetic is missing; this installer does not replace ROS.'
set +u; source /opt/ros/noetic/setup.bash; set -u
[[ ${ROS_DISTRO:-} == noetic && ${ROS_VERSION:-} == 1 ]] || fail 'ROS environment is not Noetic/ROS1.'
echo "HOST_OK ubuntu 20.04 noetic $ARCH"
if rospack find foxglove_bridge >/dev/null 2>&1; then echo BRIDGE_INSTALLED; else echo BRIDGE_MISSING; fi
[[ "$MODE" != probe ]] || exit 0
[[ "$TOKEN" =~ ^[a-f0-9]{32}$ ]] || fail 'Invalid transfer identifier.'
BASE="$HOME/.cache/pocket-rviz-installer"
[[ ! -L "$BASE" ]] || fail 'Installer cache is a symlink.'
mkdir -p "$BASE"
[[ -O "$BASE" ]] || fail 'Installer cache has a different owner.'
chmod 700 "$BASE"
WORK="$BASE/$TOKEN"
[[ ! -L "$WORK" ]] || fail 'Transfer path is a symlink.'
mkdir -p "$WORK"
[[ -O "$WORK" ]] || fail 'Transfer path has a different owner.'
chmod 700 "$WORK"
if [[ "$MODE" == plan ]]; then
  # Uses the host's existing trusted APT index; does not change sources or fetch over its network.
  # --print-uris stops before downloads/install; ForceHash avoids accepting MD5 manifests.
  apt-get --print-uris --download-only --yes --no-remove \
    -o Debug::NoLocking=1 -o Acquire::ForceHash=sha256 \
    -o Dir::Cache::archives="$WORK" install ros-noetic-foxglove-bridge > "$WORK/apt-plan.txt"
  python3 - "$WORK" <<'PY'
import pathlib,re,sys,urllib.parse,json,subprocess
try: import apt
except ImportError: raise SystemExit("ERROR: python3-apt is required on the ROS host.")
config=subprocess.check_output(['apt-config','dump'],text=True)
if re.search(r'(?im)^\s*(?:APT::Get::AllowUnauthenticated|Acquire::AllowInsecureRepositories|Acquire::AllowWeakRepositories|Acquire::AllowDowngradeToInsecureRepositories)\s+"(?:1|yes|true|on)"',config):
    raise SystemExit('ERROR: APT configuration bypasses authentication.')
cache=apt.Cache()
# Refuse explicit signature-bypass source configuration. No changes are made.
for src in [pathlib.Path("/etc/apt/sources.list"), *pathlib.Path("/etc/apt/sources.list.d").glob("*.list"), *pathlib.Path("/etc/apt/sources.list.d").glob("*.sources")]:
    if src.exists() and re.search(r"(?im)(?:\b(?:trusted|allow-insecure|allow-weak|allow-downgrade-to-insecure)\s*=|^\s*(?:Trusted|Allow-Insecure|Allow-Weak|Allow-Downgrade-To-Insecure)\s*:)", src.read_text()):
        raise SystemExit("ERROR: APT sources explicitly bypass authentication; ask the administrator to correct them.")
work=pathlib.Path(sys.argv[1]); entries=[]
for line in (work/'apt-plan.txt').read_text().splitlines():
    if not line.startswith("'"): continue
    m=re.fullmatch(r"'([^']+)' ([A-Za-z0-9_+.%:~\-]+\.deb) ([0-9]+) SHA256:([a-fA-F0-9]{64})",line)
    if not m: raise SystemExit('ERROR: APT did not provide a SHA256 package manifest; refresh trusted host metadata before retrying.')
    url,name,size,digest=m.groups();u=urllib.parse.urlsplit(url)
    if u.scheme not in ('http','https') or u.username or u.password or u.query or u.fragment:
        raise SystemExit('ERROR: Unsupported package URL.')
    if not u.hostname or not (u.hostname in ('packages.ros.org','snapshots.ros.org','archive.ubuntu.com','security.ubuntu.com','ports.ubuntu.com') or u.hostname.endswith('.archive.ubuntu.com')):
        raise SystemExit('ERROR: Package source is not an allowed official ROS/Ubuntu host: '+str(u.hostname))
    if int(size)>1024*1024*1024: raise SystemExit('ERROR: Individual package exceeds 1 GiB.')
    pkgname=name.split('_',1)[0]
    if pkgname not in cache: raise SystemExit('ERROR: Package is absent from trusted APT metadata.')
    versions=[v for v in cache[pkgname].versions if v.sha256==digest.lower() and int(v.size)==int(size) and url in v.uris]
    if not versions or not any(v.origins and all(o.trusted for o in v.origins) for v in versions):
        raise SystemExit('ERROR: Package source is not authenticated by the host APT index.')
    entries.append(dict(url=url,name=name,size=int(size),sha256=digest.lower()))
if not entries: raise SystemExit('ERROR: No package downloads planned. Bridge may already be installed, or package indexes are incomplete.')
if len(entries)>256 or sum(e['size'] for e in entries)>2*1024*1024*1024: raise SystemExit('ERROR: Package plan exceeds 256 packages / 2 GiB.')
if len({e['name'] for e in entries})!=len(entries): raise SystemExit('ERROR: Duplicate package filenames.')
(work/'manifest.json').write_text(json.dumps(entries))
for e in entries: print('PKG\t'+e['url']+'\t'+e['name']+'\t'+str(e['size'])+'\t'+e['sha256'])
print('PLAN_READY '+str(len(entries)))
PY
  exit 0
fi
if [[ "$MODE" == install ]]; then
  [[ -f "$WORK/manifest.json" && ! -L "$WORK/manifest.json" ]] || fail 'Package plan missing; start a new session.'
  python3 - "$WORK" <<'PY'
import hashlib,json,pathlib,sys
w=pathlib.Path(sys.argv[1]);entries=json.loads((w/'manifest.json').read_text())
for e in entries:
    p=w/e['name']
    if p.is_symlink() or not p.is_file() or p.stat().st_size!=e['size']: raise SystemExit('ERROR: Missing or invalid package file.')
    h=hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    if h.hexdigest()!=e['sha256']:raise SystemExit('ERROR: Package SHA256 mismatch.')
print('PACKAGES_VERIFIED')
PY
  mapfile -t files < <(python3 - "$WORK" <<'PY'
import json,pathlib,sys
w=pathlib.Path(sys.argv[1]);print('\n'.join(str(w/e['name']) for e in json.loads((w/'manifest.json').read_text())))
PY
)
  ((${#files[@]})) || fail 'Empty package manifest.'
  # -K prevents silently retaining sudo authentication after this operation.
  cleanup_sudo() { sudo -k </dev/null >/dev/null 2>&1 || true; }
  trap cleanup_sudo EXIT
  sudo -S -p '' -- env DEBIAN_FRONTEND=noninteractive apt-get --no-download --no-remove --yes install "${files[@]}"
  rospack find foxglove_bridge >/dev/null || fail 'Installation finished but bridge package cannot be resolved.'
  python3 - "$WORK" <<'PY_CLEAN'
import json,pathlib,sys
w=pathlib.Path(sys.argv[1])
for e in json.loads((w/'manifest.json').read_text()):
    p=w/e['name']
    if p.is_file() and not p.is_symlink(): p.unlink()
PY_CLEAN
  echo INSTALL_SUCCESS
  exit 0
fi
# start: no autostart, firewall, shell profile or ROS master changes.
rospack find foxglove_bridge >/dev/null || fail 'Bridge is not installed.'
command -v rosnode >/dev/null || fail 'rosnode unavailable.'
timeout 8 rosnode list >/dev/null 2>&1 || fail 'ROS master is not reachable. Start the existing robot ROS environment first.'
read -r _ _ BIND _ <<< "${SSH_CONNECTION:-}"
[[ -n ${BIND:-} ]] || fail 'Cannot determine the authenticated SSH interface address.'
python3 - "$BIND" <<'PY'
import ipaddress,socket,sys
ip=ipaddress.ip_address(sys.argv[1]);s=socket.socket(socket.AF_INET6 if ip.version==6 else socket.AF_INET)
s.settimeout(2)
if s.connect_ex((str(ip),8765))==0:raise SystemExit('ERROR: Port 8765 already has a listener; not starting or replacing it. Check the viewer connection.')
s.close()
PY
nohup roslaunch --wait foxglove_bridge foxglove_bridge.launch \
 address:="$BIND" port:=8765 capabilities:='[]' client_topic_whitelist:='[]' \
 service_whitelist:='[]' param_whitelist:='[]' asset_uri_allowlist:='[]' \
 >"$WORK/bridge-start.log" 2>&1 </dev/null &
pid=$!
echo "$pid" > "$WORK/bridge.pid"
for _ in $(seq 1 15); do
  kill -0 "$pid" 2>/dev/null || fail 'Bridge process exited. Check the host bridge-start.log.'
  if python3 - "$BIND" <<'PY'
import socket,sys,os,base64,hashlib,json,struct
try:
 s=socket.create_connection((sys.argv[1],8765),2);s.settimeout(2)
 key=base64.b64encode(os.urandom(16)).decode()
 host='['+sys.argv[1]+']' if ':' in sys.argv[1] else sys.argv[1]
 request=('GET / HTTP/1.1\r\nHost: '+host+':8765\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: foxglove.websocket.v1\r\n\r\n')
 s.sendall(request.encode());header=b''
 while not header.endswith(b'\r\n\r\n'):
  chunk=s.recv(1)
  if not chunk or len(header)>16384: raise ValueError('Invalid handshake')
  header+=chunk
 lines=header.decode('ascii').split('\r\n')
 fields=dict(line.lower().split(':',1) for line in lines[1:] if ':' in line)
 expected=base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
 # Preserve case for Sec-WebSocket-Accept, while normalizing header names.
 actual=dict((line.split(':',1)[0].lower(),line.split(':',1)[1].strip()) for line in lines[1:] if ':' in line)
 if not lines[0].startswith('HTTP/1.1 101 ') or actual.get('sec-websocket-accept')!=expected or actual.get('sec-websocket-protocol')!='foxglove.websocket.v1': raise ValueError('Not a Foxglove WebSocket handshake')
 def readn(n):
  out=b''
  while len(out)<n:
   data=s.recv(n-len(out))
   if not data: raise ValueError('Short frame')
   out+=data
  return out
 first,second=readn(2)
 if first!=0x81 or second&0x80: raise ValueError('Expected unfragmented serverInfo')
 n=second&127
 if n==126:n=struct.unpack('!H',readn(2))[0]
 elif n==127:n=struct.unpack('!Q',readn(8))[0]
 if n>1048576:raise ValueError('serverInfo too large')
 info=json.loads(readn(n))
 if info.get('op')!='serverInfo' or info.get('capabilities')!=[]:raise ValueError('Server is not read-only')
 s.close()
except (OSError,ValueError,KeyError):raise SystemExit(1)
PY
  then echo "START_SUCCESS ws://$BIND:8765 (host-side Foxglove handshake and empty capabilities verified; phone connection still needs verification)";exit 0;fi
  sleep 1
done
fail 'Start timed out. Remote process may still be running; check before retrying.'
