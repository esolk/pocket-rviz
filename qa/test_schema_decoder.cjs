// Consumer-library cross-check of independent Python wire fixtures.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const requireWeb = createRequire(require('node:path').resolve(__dirname,'../web/package.json'));
const {parse} = requireWeb('@foxglove/rosmsg');
const {MessageReader} = requireWeb('@foxglove/rosmsg-serialization');
const fixtures = JSON.parse(fs.readFileSync(__dirname+'/fixtures-data.json','utf8'));
const output = {};
for (const channel of fixtures.channels) {
 const reader = new MessageReader(parse(channel.schema));
 const bytes = Buffer.from(channel.payloadBase64,'base64');
 const result = reader.readMessage(bytes);
 assert.equal(reader.lastReadByteLength(),bytes.length);
 assert.equal(reader.lastReadHadTrailingBytes(),false);
 if (channel.schemaName==='sensor_msgs/PointCloud2') {
  assert.equal(result.point_step,24); assert.equal(result.row_step,80); assert.equal(result.data.length,160);
  const xyz=[]; const dv = new DataView(result.data.buffer,result.data.byteOffset,result.data.byteLength);
  const little=!result.is_bigendian;
  for(let row=0;row<result.height;row++)for(let col=0;col<result.width;col++){
   const o=row*result.row_step+col*result.point_step;
   const p=[dv.getFloat32(o+8,little),dv.getFloat64(o,little),dv.getInt16(o+12,little)];
   if(p.every(Number.isFinite))xyz.push(p);
  }
  assert.deepEqual(xyz,fixtures.expected.pointcloud.finite_lidar_xyz);
 }
 if(channel.id===4){assert.equal(result.data.length,256); assert.ok(result.data.includes(-1));}
 if(channel.id===5)assert.equal(result.poses.length,15);
 if(channel.id===6)assert.deepEqual(result.markers.map(m=>m.id),[7,8]);
 if(channel.id===7){assert.equal(result.format,'jpeg');assert.ok(result.data.length>100);}
 output[channel.topic]={passed:true,bytes:bytes.length,type:channel.schemaName};
}
console.log(JSON.stringify(output,null,2));
