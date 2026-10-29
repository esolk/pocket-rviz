"""Hermetic installation flow tests. No network, SSH, apt or ROS mutation."""
import hashlib,json,os,subprocess,tempfile,unittest
from pathlib import Path
SOURCE=Path(__file__).resolve().parents[1]/'android/app/src/main/assets/bridge-installer.sh'
TOKEN='a'*32
NAME='ros-noetic-foxglove-bridge_0.8.4-1focal.20250520.090425_arm64.deb'
URL='http://packages.ros.org/ros/ubuntu/pool/main/r/ros-noetic-foxglove-bridge/'+NAME
DATA=b'testdeb'
SHA=hashlib.sha256(DATA).hexdigest()
class InstallerTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
  self.home=self.root/'home';self.home.mkdir();self.bin=self.root/'bin';self.bin.mkdir()
  self.os=self.root/'os-release';self.os.write_text('ID=ubuntu\nVERSION_ID=20.04\n')
  self.ros=self.root/'setup.bash';self.ros.write_text('export ROS_VERSION=1 ROS_DISTRO=noetic\n')
  self.script=self.root/'installer.sh'
  self.script.write_text(SOURCE.read_text().replace('/etc/os-release',str(self.os)).replace('/opt/ros/noetic/setup.bash',str(self.ros)).replace('/etc/apt/',str(self.root/'apt-config')+'/'))
  self.env=dict(os.environ,HOME=str(self.home),PATH=str(self.bin)+':'+os.environ['PATH'],PYTHONPATH=str(self.root))
  self.stub('id','echo 1000');self.stub('dpkg','echo arm64');self.stub('rospack','exit 1')
  self.stub('apt-get',f'''printf "'{URL}' {NAME} {len(DATA)} SHA256:{SHA}\\n"''')
  self.stub('sudo','touch "$HOME/SUDO_CALLED"; exit 0')
  (self.root/'apt.py').write_text(f'''class Origin: trusted=True
class Version:
 sha256={SHA!r};size={len(DATA)};uris=[{URL!r}];origins=[Origin()]
class Package: versions=[Version()]
def Cache(): return {{'ros-noetic-foxglove-bridge':Package()}}
''')
 def tearDown(self):self.tmp.cleanup()
 def stub(self,name,body):p=self.bin/name;p.write_text('#!/bin/bash\n'+body+'\n');p.chmod(0o755)
 def run_script(self,mode,token=TOKEN):return subprocess.run(['bash',str(self.script),mode,token],env=self.env,capture_output=True,text=True,timeout=5)
 @property
 def work(self):return self.home/'.cache/pocket-rviz-installer'/TOKEN
 def plan(self):
  r=self.run_script('plan');self.assertEqual(r.returncode,0,r.stderr);return r
 def test_probe_no_mutation(self):
  r=self.run_script('probe');self.assertEqual(r.returncode,0,r.stderr);self.assertIn('BRIDGE_MISSING',r.stdout);self.assertEqual(list(self.home.iterdir()),[])
 def test_existing_bridge_detected(self):
  self.stub('rospack','echo /opt/ros/noetic/share/foxglove_bridge');self.assertIn('BRIDGE_INSTALLED',self.run_script('probe').stdout)
 def test_unsupported_os(self):
  self.os.write_text('ID=ubuntu\nVERSION_ID=22.04\n');self.assertNotEqual(self.run_script('probe').returncode,0)
 def test_unsupported_arch(self):
  self.stub('dpkg','echo i386');self.assertNotEqual(self.run_script('probe').returncode,0)
 def test_root_rejected(self):
  self.stub('id','echo 0');self.assertNotEqual(self.run_script('probe').returncode,0)
 def test_missing_ros(self):
  self.ros.unlink();self.assertNotEqual(self.run_script('probe').returncode,0)
 def test_token_injection_rejected(self):self.assertNotEqual(self.run_script('plan','x;touch bad').returncode,0)
 def test_plan_manifest(self):
  r=self.plan();self.assertIn('PLAN_READY 1',r.stdout);self.assertEqual(json.loads((self.work/'manifest.json').read_text())[0]['sha256'],SHA)
 def test_md5_plan_rejected(self):
  self.stub('apt-get',f'''printf "'{URL}' {NAME} 7 MD5Sum:deadbeef\\n"''');self.assertNotEqual(self.run_script('plan').returncode,0)
 def test_untrusted_metadata_rejected(self):
  p=self.root/'apt.py';p.write_text(p.read_text().replace('trusted=True','trusted=False'));self.assertNotEqual(self.run_script('plan').returncode,0)
 def test_unofficial_url_rejected(self):
  self.stub('apt-get',f'''printf "'https://evil.invalid/a.deb' a.deb 7 SHA256:{SHA}\\n"''');self.assertNotEqual(self.run_script('plan').returncode,0)
 def test_explicit_trusted_overrides_rejected(self):
  folder=self.root/'apt-config/sources.list.d';folder.mkdir(parents=True)
  for value in ('yes','true','on','1','no'):
   (folder/'ros.list').write_text('deb [trusted='+value+'] http://packages.ros.org/ros/ubuntu focal main\n')
   self.assertNotEqual(self.run_script('plan').returncode,0,value)
  (folder/'ros.list').unlink()
  (folder/'ros.sources').write_text('Types: deb\nTrusted: true\n')
  self.assertNotEqual(self.run_script('plan').returncode,0)
 def test_apt_global_bypass_rejected(self):
  self.stub('apt-config', "echo 'APT::Get::AllowUnauthenticated \"true\";'")
  self.assertNotEqual(self.run_script('plan').returncode,0)
 def test_install_missing_files_no_sudo(self):
  self.plan();self.assertNotEqual(self.run_script('install').returncode,0);self.assertFalse((self.home/'SUDO_CALLED').exists())
 def test_install_bad_hash_no_sudo(self):
  self.plan();(self.work/NAME).write_bytes(b'badxxxx');self.assertNotEqual(self.run_script('install').returncode,0);self.assertFalse((self.home/'SUDO_CALLED').exists())
 def test_install_verified_files(self):
  self.plan();(self.work/NAME).write_bytes(DATA);self.stub('rospack','echo /mock/bridge')
  r=self.run_script('install');self.assertEqual(r.returncode,0,r.stderr);self.assertIn('INSTALL_SUCCESS',r.stdout);self.assertTrue((self.home/'SUDO_CALLED').exists())
 def test_missing_master_does_not_start(self):
  self.stub('rospack','echo /mock/bridge');self.stub('rosnode','exit 1');r=self.run_script('start');self.assertNotEqual(r.returncode,0);self.assertIn('ROS master',r.stderr)
if __name__=='__main__':unittest.main()
