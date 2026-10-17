#!/usr/bin/env python3
"""Serve the production build under the Android shell's exact CSP for QA.
This is a desktop Chromium compatibility check, not an Android WebView test.
The HTTP localhost origin differs from Android's HTTPS appassets origin.
"""
import argparse, functools
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
CSP="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws: wss:; worker-src 'self' blob:; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'"
class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Content-Security-Policy',CSP)
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Cache-Control','no-cache')
        self.send_header('Permissions-Policy','camera=(), microphone=(), geolocation=()')
        super().end_headers()
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--directory',default='../web/dist');p.add_argument('--port',type=int,default=4173)
    args=p.parse_args();server=ThreadingHTTPServer(('127.0.0.1',args.port),functools.partial(Handler,directory=args.directory))
    print(f'Production CSP QA server http://127.0.0.1:{args.port}',flush=True)
    server.serve_forever()
