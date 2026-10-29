"""Exercise the exact embedded host-side startup handshake against a local socket fixture."""
from pathlib import Path
import base64,hashlib,json,re,socket,subprocess,threading,unittest
SOURCE=Path(__file__).resolve().parents[1]/'android/app/src/main/assets/bridge-installer.sh'
CODE=SOURCE.read_text().split('import socket,sys,os,base64,hashlib,json,struct\n',1)[1].split('\nPY\n',1)[0]
CODE='import socket,sys,os,base64,hashlib,json,struct\n'+CODE
class HandshakeTest(unittest.TestCase):
 def check(self,capabilities,protocol='foxglove.websocket.v1',bad_accept=False):
  server=socket.socket();server.bind(('127.0.0.1',0));server.listen(1);server.settimeout(5)
  port=server.getsockname()[1]
  def serve():
   try:
    conn,_=server.accept();conn.settimeout(5)
    with conn:
     data=b''
     while b'\r\n\r\n' not in data:data+=conn.recv(4096)
     key=re.search(b'Sec-WebSocket-Key: ([^\r]+)',data).group(1)
     accept=base64.b64encode(hashlib.sha1(key+b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest()).decode()
     if bad_accept:accept='wrong'
     response='HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\nSec-WebSocket-Protocol: '+protocol+'\r\n\r\n'
     body=json.dumps(dict(op='serverInfo',capabilities=capabilities)).encode()
     conn.sendall(response.encode()+bytes([0x81,len(body)])+body)
   finally:server.close()
  t=threading.Thread(target=serve);t.start()
  result=subprocess.run(['python3','-c',CODE.replace('8765',str(port)),'127.0.0.1'],capture_output=True,timeout=5)
  t.join(5);return result.returncode
 def test_valid_readonly(self):self.assertEqual(self.check([]),0)
 def test_writable_rejected(self):self.assertNotEqual(self.check(['clientPublish']),0)
 def test_wrong_protocol(self):self.assertNotEqual(self.check([],'rosbridge'),0)
 def test_invalid_accept(self):self.assertNotEqual(self.check([],bad_accept=True),0)
if __name__=='__main__':unittest.main()
