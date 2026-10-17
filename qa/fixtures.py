"""Independent synthetic ROS1 fixtures. No app decoder code is imported.

ROS1 wire format is little-endian with length-prefixed strings and arrays.
PointCloud2's data payload has its own is_bigendian flag, tested separately.
"""
import io, math, struct
from PIL import Image, ImageDraw

HEADER = 'uint32 seq\ntime stamp\nstring frame_id'
POINT = 'float64 x\nfloat64 y\nfloat64 z'
QUATERNION = 'float64 x\nfloat64 y\nfloat64 z\nfloat64 w'
POSE = 'geometry_msgs/Point position\ngeometry_msgs/Quaternion orientation'
TRANSFORM = 'geometry_msgs/Vector3 translation\ngeometry_msgs/Quaternion rotation'
TRANSFORM_STAMPED = 'std_msgs/Header header\nstring child_frame_id\ngeometry_msgs/Transform transform'
POSE_STAMPED = 'std_msgs/Header header\ngeometry_msgs/Pose pose'
POINTFIELD = 'uint8 INT8=1\nuint8 UINT8=2\nuint8 INT16=3\nuint8 UINT16=4\nuint8 INT32=5\nuint8 UINT32=6\nuint8 FLOAT32=7\nuint8 FLOAT64=8\nstring name\nuint32 offset\nuint8 datatype\nuint32 count'
PC2 = 'std_msgs/Header header\nuint32 height\nuint32 width\nsensor_msgs/PointField[] fields\nbool is_bigendian\nuint32 point_step\nuint32 row_step\nuint8[] data\nbool is_dense'
MAP_META = 'time map_load_time\nfloat32 resolution\nuint32 width\nuint32 height\ngeometry_msgs/Pose origin'
MARKER = '''uint8 ARROW=0
uint8 CUBE=1
uint8 SPHERE=2
uint8 CYLINDER=3
uint8 LINE_STRIP=4
uint8 LINE_LIST=5
uint8 CUBE_LIST=6
uint8 SPHERE_LIST=7
uint8 POINTS=8
uint8 TEXT_VIEW_FACING=9
uint8 MESH_RESOURCE=10
uint8 TRIANGLE_LIST=11
uint8 ADD=0
uint8 MODIFY=0
uint8 DELETE=2
uint8 DELETEALL=3
std_msgs/Header header
string ns
int32 id
int32 type
int32 action
geometry_msgs/Pose pose
geometry_msgs/Vector3 scale
std_msgs/ColorRGBA color
duration lifetime
bool frame_locked
geometry_msgs/Point[] points
std_msgs/ColorRGBA[] colors
string text
string mesh_resource
bool mesh_use_embedded_materials'''
DEFS = {'std_msgs/Header': HEADER, 'geometry_msgs/Point': POINT, 'geometry_msgs/Vector3': POINT,
        'geometry_msgs/Quaternion': QUATERNION, 'geometry_msgs/Pose': POSE,
        'geometry_msgs/Transform': TRANSFORM, 'geometry_msgs/TransformStamped': TRANSFORM_STAMPED,
        'geometry_msgs/PoseStamped': POSE_STAMPED, 'sensor_msgs/PointField': POINTFIELD,
        'std_msgs/ColorRGBA': 'float32 r\nfloat32 g\nfloat32 b\nfloat32 a',
        'nav_msgs/MapMetaData': MAP_META, 'visualization_msgs/Marker': MARKER}

def schema(root, deps):
    return root + ''.join('\n' + '='*80 + '\nMSG: '+d+'\n'+DEFS[d] for d in deps)

POSE_DEPS = ['std_msgs/Header', 'geometry_msgs/PoseStamped', 'geometry_msgs/Pose', 'geometry_msgs/Point', 'geometry_msgs/Quaternion']
SCHEMAS = {
    'tf2_msgs/TFMessage': schema('geometry_msgs/TransformStamped[] transforms', ['geometry_msgs/TransformStamped','std_msgs/Header','geometry_msgs/Transform','geometry_msgs/Vector3','geometry_msgs/Quaternion']),
    'sensor_msgs/PointCloud2': schema(PC2, ['std_msgs/Header','sensor_msgs/PointField']),
    'nav_msgs/OccupancyGrid': schema('std_msgs/Header header\nnav_msgs/MapMetaData info\nint8[] data', ['std_msgs/Header','nav_msgs/MapMetaData','geometry_msgs/Pose','geometry_msgs/Point','geometry_msgs/Quaternion']),
    'nav_msgs/Path': schema('std_msgs/Header header\ngeometry_msgs/PoseStamped[] poses', POSE_DEPS),
    'visualization_msgs/MarkerArray': schema('visualization_msgs/Marker[] markers', ['visualization_msgs/Marker','std_msgs/Header','geometry_msgs/Pose','geometry_msgs/Point','geometry_msgs/Quaternion','geometry_msgs/Vector3','std_msgs/ColorRGBA']),
    'sensor_msgs/CompressedImage': schema('std_msgs/Header header\nstring format\nuint8[] data', ['std_msgs/Header']),
}
TOPICS = [(1,'/tf','tf2_msgs/TFMessage'), (2,'/tf_static','tf2_msgs/TFMessage'),
          (3,'/qa/points_mixed','sensor_msgs/PointCloud2'), (4,'/qa/map','nav_msgs/OccupancyGrid'),
          (5,'/qa/path','nav_msgs/Path'), (6,'/qa/markers','visualization_msgs/MarkerArray'),
          (7,'/qa/camera/compressed','sensor_msgs/CompressedImage'),
          (8,'/qa/points_bigendian','sensor_msgs/PointCloud2')]
CHANNELS = [dict(id=id, topic=topic, encoding='ros1', schemaName=name, schema=SCHEMAS[name], schemaEncoding='ros1msg') for id,topic,name in TOPICS]

def u32(v): return struct.pack('<I',v)
def string(v):
    b=v.encode(); return u32(len(b))+b

def stamp(t):
    s=int(t); return struct.pack('<II',s,round((t-s)*1e9))
def header(frame='map', tick=0): return u32(tick)+stamp(1000+tick*.1)+string(frame)
def vector(x=0,y=0,z=0): return struct.pack('<ddd',x,y,z)
def quat(yaw=0): return struct.pack('<dddd',0,0,math.sin(yaw/2),math.cos(yaw/2))
def pose(x=0,y=0,z=0,yaw=0): return vector(x,y,z)+quat(yaw)
def array(items): return u32(len(items))+b''.join(items)

def transform(parent, child, xyz, yaw=0, tick=0):
    return header(parent,tick)+string(child)+vector(*xyz)+quat(yaw)
def tf(tick=0, static=False):
    return array([transform('base_link','lidar',(0.5,0,0.25),tick=tick)]) if static else array([transform('map','base_link',(2+0.2*math.sin(tick*.1),1,0),math.pi/2,tick)])

POINTS = [(-1.0,0.0,0,0xffe255),(0.0,1.0,1,0x67e8f9),(1.0,0.0,2,0xf97316),(-1.0,2.0,-1,0x38bdf8),(0.0,3.0,0,0xa78bfa),(float('nan'),1.0,1,0xffffff)]
def pointcloud(tick=0, big=False):
    fields=[('y',0,8,1),('x',8,7,1),('z',12,3,1),('intensity',14,4,1),('rgb',16,6,1)]
    rows=[]
    for row in range(2):
        points=[]
        for i,(x,y,z,rgb) in enumerate(POINTS[row*3:row*3+3]):
            points.append(struct.pack(('>' if big else '<')+'dfhHI',y,x,z,100*(row*3+i+1),rgb)+b'\xaa\xbb\xcc\xdd')
        rows.append(b''.join(points)+b'ROWPAD!!')
    data=b''.join(rows)
    field_bytes=array([string(n)+u32(o)+bytes([d])+u32(c) for n,o,d,c in fields])
    return header('lidar',tick)+u32(2)+u32(3)+field_bytes+bytes([big])+u32(24)+u32(80)+u32(len(data))+data+b'\x00'

def occupancy(tick=0):
    w=h=16
    cells=[100 if x in (0,w-1) or y in (0,h-1) or (x in (5,6) and y in range(4,12)) else -1 if (x>10 and y>10) else 0 for y in range(h) for x in range(w)]
    return header('map',tick)+stamp(1000)+struct.pack('<fII',0.5,w,h)+pose(-2,-2)+u32(len(cells))+struct.pack('<'+'b'*len(cells),*cells)

def path(tick=0):
    return header('map',tick)+array([header('map',tick)+pose(-1+i*.5, 2+math.sin(i*.4),0.04) for i in range(15)])

def marker(id=7, action=0, tick=0, ns='SYNTHETIC_QA', kind=1):
    return (header('map',tick)+string(ns)+struct.pack('<iii',id,kind,action)+pose(3 if id==7 else 1,3,0.5)+vector(.7,.7,1)
            +struct.pack('<ffff',1,.45,.15,1)+struct.pack('<ii',0,0)+b'\x00'+u32(0)+u32(0)+string('SYNTHETIC QA')+string('')+b'\x00')

def markers(tick=0, action='add'):
    if action=='delete': return array([marker(7,2,tick)])
    if action=='deleteall': return array([marker(0,3,tick)])
    return array([marker(7,0,tick),marker(8,0,tick,kind=2)])

def compressed(tick=0):
    im=Image.new('RGB',(320,180),(15,23,42)); draw=ImageDraw.Draw(im)
    draw.rectangle((10,40,110,160),fill=(56,189,248)); draw.rectangle((120,40,210,160),fill=(251,146,60))
    draw.rectangle((220,40,310,160),fill=(167,139,250)); draw.text((12,12),'SYNTHETIC QA / NO ROBOT CAMERA',fill=(255,255,255))
    out=io.BytesIO(); im.save(out,format='JPEG'); data=out.getvalue()
    return header('lidar',tick)+string('jpeg')+u32(len(data))+data
IMAGE = compressed()
def payload(channel,tick=0,marker_action='add'):
    return {1:lambda:tf(tick),2:lambda:tf(tick,True),3:lambda:pointcloud(tick),4:lambda:occupancy(tick),5:lambda:path(tick),6:lambda:markers(tick,marker_action),7:lambda:IMAGE,8:lambda:pointcloud(tick,True)}[channel]()

def packet(subscription,payload,tick=0):
    return struct.pack('<BIQ',1,subscription,1_000_000_000_000+tick*100_000_000)+payload

EXPECTED = {
    'source':'independent synthetic Python serializer; no physical ROS robot or bridge process',
    'protocol':'foxglove.websocket.v1', 'binary_header_bytes':13,
    'pointcloud':{'height':2,'width':3,'point_step':24,'row_step':80,'data_bytes':160,'finite_points':5,
                  'finite_lidar_xyz':[[x,y,z] for x,y,z,rgb in POINTS if math.isfinite(x)],
                  'finite_map_xyz_tick_0':[[2-y,1+x+.5,z+.25] for x,y,z,rgb in POINTS if math.isfinite(x)],
                  'rgb_uint32':[rgb for x,y,z,rgb in POINTS if math.isfinite(x)]},
    'tf_tick_0':{'map_to_base_link':{'translation':[2,1,0],'yaw_rad':math.pi/2},'base_link_to_lidar':{'translation':[.5,0,.25],'yaw_rad':0}},
    'occupancy':{'width':16,'height':16,'resolution':.5,'origin':[-2,-2,0]},
    'path_poses':15, 'marker_ids_added':[7,8],'marker_ids_after_delete_7':[8],'marker_ids_after_deleteall':[],
    'image':{'width':320,'height':180,'format':'jpeg','label':'SYNTHETIC QA / NO ROBOT CAMERA'}
}
if __name__=='__main__':
    import json,pathlib
    target=pathlib.Path(__file__).parent/'expected.json'
    target.write_text(json.dumps(EXPECTED,indent=2)+'\n'); print(target)
