import base64,json,pathlib
from fixtures import CHANNELS,payload,EXPECTED
out={'expected':EXPECTED,'channels':[{**c,'payloadBase64':base64.b64encode(payload(c['id'])).decode()} for c in CHANNELS]}
p=pathlib.Path(__file__).parent/'fixtures-data.json';p.write_text(json.dumps(out,indent=2)+'\n');print(p)
