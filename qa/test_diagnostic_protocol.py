#!/usr/bin/env python3
"""Independent socket checks of deterministic diagnostic scenario fixtures."""
import asyncio
import json
import tempfile
import unittest
from types import SimpleNamespace
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed
from diagnostic_bridge import DiagnosticBridge, SECRET_REASON


class ScenarioTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.bridge = DiagnosticBridge(SimpleNamespace(
            state_file=self.temp.name + '/state.json', control_file=self.temp.name + '/control.json',
            port=0, close_delay=.03))
        self.server = await serve(self.bridge.handler, '127.0.0.1', 0,
                                  subprotocols=['foxglove.websocket.v1'])
        self.url = f'ws://127.0.0.1:{self.server.sockets[0].getsockname()[1]}'

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()
        self.temp.cleanup()

    def connection(self, scenario):
        return connect(self.url + '/' + scenario, subprotocols=['foxglove.websocket.v1'])

    async def test_open_without_server_info(self):
        async with self.connection('open-no-info') as ws:
            self.assertEqual(ws.subprotocol, 'foxglove.websocket.v1')
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(ws.recv(), .05)

    async def test_empty_info_and_no_advertise(self):
        async with self.connection('empty-info') as ws:
            self.assertEqual(json.loads(await ws.recv()), {'op': 'serverInfo'})
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(ws.recv(), .05)

    async def test_info_and_no_advertise(self):
        async with self.connection('info-no-advertise') as ws:
            self.assertEqual(json.loads(await ws.recv())['op'], 'serverInfo')
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(ws.recv(), .05)

    async def test_explicit_zero_topics(self):
        async with self.connection('zero-topics') as ws:
            await ws.recv()
            self.assertEqual(json.loads(await ws.recv()), {'op': 'advertise', 'channels': []})

    async def test_unsupported_schema(self):
        async with self.connection('unsupported') as ws:
            await ws.recv()
            channel = json.loads(await ws.recv())['channels'][0]
            self.assertEqual(channel['encoding'], 'cdr')
            self.assertEqual(channel['schemaEncoding'], 'ros2msg')

    async def test_normal_eight_topics(self):
        async with self.connection('normal') as ws:
            await ws.recv()
            self.assertEqual(len(json.loads(await ws.recv())['channels']), 8)
            await ws.send(json.dumps({'op': 'subscribe', 'subscriptions': [{'id': 1, 'channelId': 3}]}))
            self.assertIsInstance(await ws.recv(), bytes)
            await ws.send(json.dumps({'op': 'unsubscribe', 'subscriptionIds': [1]}))
        self.assertFalse(any(e['event'].startswith('forbidden_') for e in self.bridge.events))

    async def test_close_codes_and_redaction_canary(self):
        for code in (1000, 1008, 1011):
            with self.subTest(code=code):
                async with self.connection(f'close-{code}') as ws:
                    await ws.recv()
                    await ws.recv()
                    with self.assertRaises(ConnectionClosed):
                        await ws.recv()
                    self.assertEqual(ws.close_code, code)
                    self.assertEqual(ws.close_reason, SECRET_REASON)

if __name__ == '__main__':
    unittest.main(verbosity=2)
