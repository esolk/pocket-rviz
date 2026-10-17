#!/usr/bin/env python3
"""Independent byte assertions and socket lifecycle smoke test.
Run with `python test_fixture_protocol.py`; no web application or ROS required.
"""
import asyncio, json, math, struct, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from fixtures import *
from fake_bridge import FakeBridge

class Cursor:
    def __init__(self,b): self.b=b; self.p=0
    def take(self,n): b=self.b[self.p:self.p+n]; self.p+=n; assert len(b)==n; return b
    def unpack(self,fmt): return struct.unpack(fmt,self.take(struct.calcsize(fmt)))
    def u32(self): return self.unpack('<I')[0]
    def string(self): return self.take(self.u32()).decode()
    def header(self): return self.u32(),self.unpack('<II'),self.string()

class FixtureTests(unittest.TestCase):
    def test_pc2_mixed_padding_and_endianness(self):
        for big in [False,True]:
            r=Cursor(pointcloud(big=big)); self.assertEqual(r.header()[2],'lidar'); self.assertEqual((r.u32(),r.u32()),(2,3))
            fields={}
            for _ in range(r.u32()):
                name=r.string(); fields[name]=(r.u32(),r.unpack('<B')[0],r.u32())
            self.assertEqual(r.unpack('<?')[0],big); pointstep,rowstep=r.u32(),r.u32(); data=r.take(r.u32())
            self.assertEqual((pointstep,rowstep,len(data)),(24,80,160)); self.assertEqual(r.take(1),b'\x00'); self.assertEqual(r.p,len(r.b))
            actual=[]
            for row in range(2):
                self.assertEqual(data[row*80+72:row*80+80],b'ROWPAD!!')
                for col in range(3):
                    o=row*rowstep+col*pointstep; endian='>' if big else '<'
                    x=struct.unpack_from(endian+'f',data,o+fields['x'][0])[0]
                    y=struct.unpack_from(endian+'d',data,o+fields['y'][0])[0]
                    z=struct.unpack_from(endian+'h',data,o+fields['z'][0])[0]
                    if math.isfinite(x): actual.append([x,y,z])
            self.assertEqual(actual,EXPECTED['pointcloud']['finite_lidar_xyz'])
    def test_protocol_envelope(self):
        r=packet(123,b'hello',7); self.assertEqual(len(r),18)
        self.assertEqual(struct.unpack('<BIQ',r[:13]),(1,123,1_000_700_000_000)); self.assertEqual(r[13:],b'hello')
    def test_marker_actions(self):
        for action,ids,codes in [('add',[7,8],[0,0]),('delete',[7],[2]),('deleteall',[0],[3])]:
            r=Cursor(markers(action=action)); count=r.u32(); self.assertEqual(count,len(ids))
            got=[]
            for _ in range(count):
                r.header(); self.assertEqual(r.string(),'SYNTHETIC_QA'); got.append(r.unpack('<iii'))
                r.take(56+24+16+8+1); self.assertEqual(r.u32(),0); self.assertEqual(r.u32(),0)
                r.string();r.string();r.take(1)
            self.assertEqual([x[0] for x in got],ids); self.assertEqual([x[2] for x in got],codes); self.assertEqual(r.p,len(r.b))
    def test_image_label_and_size(self):
        r=Cursor(IMAGE); r.header(); self.assertEqual(r.string(),'jpeg'); im=Image.open(io.BytesIO(r.take(r.u32())))
        self.assertEqual(im.size,(320,180))
    def test_tf_expected_composition(self):
        # Direct analytic rotation by +90 degrees, independent of app math.
        for local,expected in zip(EXPECTED['pointcloud']['finite_lidar_xyz'],EXPECTED['pointcloud']['finite_map_xyz_tick_0']):
            x,y,z=local; self.assertEqual([2-y,1+(x+.5),z+.25],expected)

class SocketTests(unittest.IsolatedAsyncioTestCase):
    async def test_live_subscription_lifecycle(self):
        with tempfile.TemporaryDirectory() as td:
            args=SimpleNamespace(state_file=td+'/state.json',control_file=td+'/control.json',host='127.0.0.1',port=0)
            bridge=FakeBridge(args)
            async with serve(bridge.handler,'127.0.0.1',0,subprotocols=['foxglove.websocket.v1']) as server:
                port=server.sockets[0].getsockname()[1]
                async with connect(f'ws://127.0.0.1:{port}',subprotocols=['foxglove.websocket.v1']) as ws:
                    self.assertEqual(ws.subprotocol,'foxglove.websocket.v1')
                    info=json.loads(await ws.recv()); self.assertEqual(info['capabilities'],[])
                    ad=json.loads(await ws.recv()); self.assertEqual(len(ad['channels']),8)
                    await ws.send(json.dumps({'op':'subscribe','subscriptions':[{'id':42,'channelId':3}]}))
                    data=await ws.recv(); self.assertIsInstance(data,bytes); self.assertEqual(struct.unpack_from('<I',data,1)[0],42)
                    self.assertEqual(data[13:],pointcloud())
                    await ws.send(json.dumps({'op':'unsubscribe','subscriptionIds':[42]})); await asyncio.sleep(.02)
                    self.assertEqual(next(iter(bridge.clients.values()))['subs'],{})
                await asyncio.sleep(.02); self.assertFalse(bridge.clients)
                events=[e['event'] for e in bridge.events]; self.assertIn('disconnect',events)
                self.assertNotIn('forbidden_client_operation',events)

if __name__=='__main__': unittest.main(verbosity=2)
