#!/usr/bin/env python3
"""Local synthetic Foxglove v1 server for QA, never a production ROS bridge.

JSON control file commands: disconnect, unadvertise, advertise, marker_delete,
marker_deleteall, marker_add. State includes observed client operations and byte
counts; no client publish/parameter/service operations are accepted.
"""
import argparse, asyncio, json, pathlib, signal, time
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed
from fixtures import CHANNELS, payload, packet

class FakeBridge:
    def __init__(self,args):
        self.args=args; self.clients={}; self.events=[]; self.tick=0; self.next_id=1; self.last_control=None
    def record(self, event, **fields):
        self.events.append(dict(time=time.time(), event=event, **fields)); self.events=self.events[-1000:]
        self.save()
    def save(self):
        state={'synthetic':True,'tick':self.tick,'events':self.events,'clients':{str(k):{'subscriptions':v['subs'],'sent':v['sent']} for k,v in self.clients.items()}}
        p=pathlib.Path(self.args.state_file); tmp=p.with_suffix('.tmp'); tmp.write_text(json.dumps(state,indent=2)); tmp.replace(p)
    async def handler(self,ws):
        cid=self.next_id; self.next_id+=1
        self.clients[cid]={'ws':ws,'subs':{},'sent':{},'marker_state':'add'}
        self.record('connect',client=cid,subprotocol=ws.subprotocol)
        await ws.send(json.dumps({'op':'serverInfo','name':'SYNTHETIC QA · no robot','capabilities':[],'metadata':{'source':'independent QA fixtures'},'sessionId':'synthetic-qa-v1'}))
        await ws.send(json.dumps({'op':'advertise','channels':CHANNELS}))
        self.record('advertise_sent',client=cid,channels=[c['id'] for c in CHANNELS])
        try:
            async for message in ws:
                if isinstance(message,bytes):
                    self.record('forbidden_client_binary',client=cid,bytes=len(message)); continue
                try: msg=json.loads(message)
                except (ValueError,TypeError): self.record('malformed_json',client=cid); continue
                self.record('client_message',client=cid,message=msg)
                if msg.get('op')=='subscribe':
                    for sub in msg.get('subscriptions',[]):
                        sid,ch=sub.get('id'),sub.get('channelId')
                        if sid in self.clients[cid]['subs'] or ch not in [c['id'] for c in CHANNELS]:
                            await ws.send(json.dumps({'op':'status','level':2,'message':'Invalid or duplicate subscription'})); continue
                        self.clients[cid]['subs'][sid]=ch
                        await self.send(cid,sid,ch)
                elif msg.get('op')=='unsubscribe':
                    for sid in msg.get('subscriptionIds',[]): self.clients[cid]['subs'].pop(sid,None)
                else:
                    self.record('forbidden_client_operation',client=cid,op=msg.get('op'))
                    await ws.send(json.dumps({'op':'status','level':2,'message':'Synthetic read-only server accepts subscribe/unsubscribe only'}))
                self.save()
        except ConnectionClosed: pass
        finally:
            self.record('disconnect',client=cid)
            self.clients.pop(cid,None); self.save()
    async def send(self,cid,sid,ch,action='add'):
        item=self.clients.get(cid)
        if not item: return
        data=packet(sid,payload(ch,self.tick,action),self.tick)
        await item['ws'].send(data)
        item['sent'][ch]=item['sent'].get(ch,0)+1
    async def control(self,command):
        op=command.get('op'); self.record('control',command=command)
        for cid,item in list(self.clients.items()):
            if op=='disconnect': await item['ws'].close(code=1012,reason='SYNTHETIC QA forced restart')
            elif op in ('unadvertise','advertise'):
                if op=='unadvertise':
                    ids=command.get('channelIds',[3]); await item['ws'].send(json.dumps({'op':op,'channelIds':ids}))
                    item['subs']={sid:ch for sid,ch in item['subs'].items() if ch not in ids}
                else: await item['ws'].send(json.dumps({'op':'advertise','channels':[c for c in CHANNELS if c['id'] in command.get('channelIds',[3])]}))
            elif op in ('marker_delete','marker_deleteall','marker_add'):
                action=op.removeprefix('marker_'); item['marker_state']=action
                for sid,ch in list(item['subs'].items()):
                    if ch==6: await self.send(cid,sid,ch,action)
        self.save()
    async def ticker(self):
        while True:
            await asyncio.sleep(.1); self.tick+=1
            p=pathlib.Path(self.args.control_file)
            if p.exists():
                try:
                    command=json.loads(p.read_text())
                    if command.get('seq')!=self.last_control:
                        self.last_control=command.get('seq'); await self.control(command)
                except (ValueError,OSError): pass
            for cid,item in list(self.clients.items()):
                for sid,ch in list(item['subs'].items()):
                    # Latched TF and map stay available without needless streaming.
                    if ch in (2,4,6): continue
                    if ch==7 and self.tick%10: continue
                    try: await self.send(cid,sid,ch)
                    except ConnectionClosed: pass
            if self.tick%5==0: self.save()
    async def run(self):
        pathlib.Path(self.args.state_file).parent.mkdir(parents=True,exist_ok=True)
        self.record('server_start',host=self.args.host,port=self.args.port)
        async with serve(self.handler,self.args.host,self.args.port,subprotocols=['foxglove.websocket.v1'],compression=None):
            print(f'SYNTHETIC QA bridge listening ws://{self.args.host}:{self.args.port}',flush=True)
            await self.ticker()

if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('--host',default='127.0.0.1'); p.add_argument('--port',type=int,default=8765)
    p.add_argument('--state-file',default='artifacts/bridge-state.json'); p.add_argument('--control-file',default='artifacts/control.json')
    args=p.parse_args()
    try: asyncio.run(FakeBridge(args).run())
    except KeyboardInterrupt: pass
