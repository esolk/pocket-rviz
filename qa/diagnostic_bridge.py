#!/usr/bin/env python3
"""Loopback-only, synthetic Foxglove diagnostics scenarios; no ROS connection.

Paths: /normal, /open-no-info, /empty-info, /info-no-advertise,
/zero-topics, /unsupported, /close-1000, /close-1008, /close-1011.
Refused connections must target an unused local port, not this listener.
"""
import argparse
import asyncio
import json
from pathlib import Path
from urllib.parse import urlsplit

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed
from fake_bridge import FakeBridge
from fixtures import CHANNELS

SCENARIOS = {
    'normal', 'open-no-info', 'empty-info', 'info-no-advertise',
    'zero-topics', 'unsupported', 'close-1000', 'close-1008', 'close-1011',
}
# These are deliberately public, fake canaries to test secret redaction.
SECRET_REASON = 'token=QA_SECRET_TOKEN password=QA_SECRET_PASSWORD ws://user:QA_PASS@localhost/?key=QA_KEY'


class DiagnosticBridge(FakeBridge):
    async def handler(self, ws):
        scenario = urlsplit(ws.request.path).path.strip('/') or 'normal'
        if scenario not in SCENARIOS:
            await ws.close(code=1008, reason='Unknown synthetic scenario')
            return
        cid = self.next_id
        self.next_id += 1
        self.clients[cid] = {'ws': ws, 'subs': {}, 'sent': {}, 'marker_state': 'add'}
        self.record('connect', client=cid, scenario=scenario, subprotocol=ws.subprotocol)
        closer = None
        try:
            if scenario != 'open-no-info':
                info = {'op': 'serverInfo'} if scenario == 'empty-info' else {
                    'op': 'serverInfo', 'name': 'SYNTHETIC diagnostics QA',
                    'capabilities': [], 'sessionId': 'synthetic-diagnostics-v1',
                }
                await ws.send(json.dumps(info))
            if scenario in ('normal', 'unsupported') or scenario.startswith('close-'):
                channels = CHANNELS if scenario != 'unsupported' else [{
                    'id': 99, 'topic': '/qa/unsupported', 'encoding': 'cdr',
                    'schemaName': 'sensor_msgs/PointCloud2',
                    'schemaEncoding': 'ros2msg', 'schema': 'uint32 value',
                }]
                await ws.send(json.dumps({'op': 'advertise', 'channels': channels}))
                self.record('advertise_sent', client=cid, channels=[c['id'] for c in channels])
            elif scenario == 'zero-topics':
                await ws.send(json.dumps({'op': 'advertise', 'channels': []}))
                self.record('advertise_sent', client=cid, channels=[])
            if scenario.startswith('close-'):
                async def close_later():
                    await asyncio.sleep(getattr(self.args, 'close_delay', 2.0))
                    await ws.close(code=int(scenario.split('-')[1]), reason=SECRET_REASON)
                closer = asyncio.create_task(close_later())
            async for raw in ws:
                if isinstance(raw, bytes):
                    self.record('forbidden_client_binary', client=cid, bytes=len(raw))
                    continue
                try:
                    message = json.loads(raw)
                except (TypeError, ValueError):
                    self.record('malformed_json', client=cid)
                    continue
                self.record('client_message', client=cid, message=message)
                if message.get('op') == 'subscribe':
                    for sub in message.get('subscriptions', []):
                        sid, ch = sub.get('id'), sub.get('channelId')
                        if ch not in [c['id'] for c in CHANNELS]:
                            continue
                        self.clients[cid]['subs'][sid] = ch
                        await self.send(cid, sid, ch)
                elif message.get('op') == 'unsubscribe':
                    for sid in message.get('subscriptionIds', []):
                        self.clients[cid]['subs'].pop(sid, None)
                else:
                    self.record('forbidden_client_operation', client=cid, op=message.get('op'))
            self.save()
        except ConnectionClosed:
            pass
        finally:
            if closer:
                closer.cancel()
            self.record('disconnect', client=cid, scenario=scenario, code=ws.close_code)
            self.clients.pop(cid, None)
            self.save()

    async def run(self):
        Path(self.args.state_file).parent.mkdir(parents=True, exist_ok=True)
        self.record('server_start', host='127.0.0.1', port=self.args.port)
        async with serve(self.handler, '127.0.0.1', self.args.port,
                         subprotocols=['foxglove.websocket.v1'], compression=None):
            print(f'SYNTHETIC diagnostics ws://127.0.0.1:{self.args.port}/normal', flush=True)
            await self.ticker()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8876)
    parser.add_argument('--close-delay', type=float, default=2.0)
    parser.add_argument('--state-file', default='artifacts/diagnostic-bridge-state.json')
    parser.add_argument('--control-file', default='artifacts/diagnostic-control.json')
    try:
        asyncio.run(DiagnosticBridge(parser.parse_args()).run())
    except KeyboardInterrupt:
        pass
