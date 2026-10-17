#!/usr/bin/env python3
"""Synthetic CSS-viewport shell; app's own headers/CSP remain unchanged."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse,parse_qs
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  q=parse_qs(urlparse(self.path).query); w=int(q.get('w',[915])[0]); h=int(q.get('h',[412])[0]); w=max(320,min(w,1024));h=max(320,min(h,1024))
  html=f'''<!doctype html><html><head><meta charset="utf-8"><title>SYNTHETIC QA CSS viewport</title><style>body{{margin:12px;font:14px system-ui;background:#dbe4ed}}a{{margin:0 12px}}iframe{{border:2px solid #315769;width:{w}px;height:{h}px;display:block}}small{{display:block;margin:8px 0}}h1{{font-size:18px;margin:0}}pre{{font-size:11px;white-space:pre-wrap;max-width:1000px}}</style></head><body><h1>SYNTHETIC QA · {w} × {h} CSS pixels</h1><small>Desktop Chromium / software rendering / mouse & keyboard. Not Android or touch emulation.</small><nav><a href="/?w=915&h=412">915×412 landscape</a><a href="/?w=800&h=360">800×360 landscape</a><a href="/?w=412&h=700">412×700 portrait</a></nav><iframe src="http://127.0.0.1:4173/" title="ROS viewer under exact Android CSP"></iframe><p>App runs with its unchanged strict CSP. Local bridge data are entirely synthetic.</p></body></html>'''
  self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(html.encode())
ThreadingHTTPServer(('127.0.0.1',4174),Handler).serve_forever()
