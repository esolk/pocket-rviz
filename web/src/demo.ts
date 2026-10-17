import type { Topic, Packet } from "./client";
const types = [
  "tf2_msgs/TFMessage",
  "tf2_msgs/TFMessage",
  "nav_msgs/OccupancyGrid",
  "sensor_msgs/PointCloud2",
  "nav_msgs/Path",
  "nav_msgs/Odometry",
  "visualization_msgs/MarkerArray",
  "sensor_msgs/Image",
];
const names = [
  "/tf",
  "/tf_static",
  "/map",
  "/lidar/points",
  "/navigation/path",
  "/odom",
  "/scene/markers",
  "/camera/image",
];
const point = (x = 0, y = 0, z = 0) => ({ x, y, z });
const q = (angle = 0) => ({
  x: 0,
  y: 0,
  z: Math.sin(angle / 2),
  w: Math.cos(angle / 2),
});
const stamp = (n: number) => ({
  sec: Math.floor(n),
  nsec: Math.floor((n % 1) * 1e9),
});
const header = (frame = "map", time = 100) => ({
  frame_id: frame,
  stamp: stamp(time),
});
const pose = (x = 0, y = 0, z = 0, a = 0) => ({
  position: point(x, y, z),
  orientation: q(a),
});
/** Completely offline deterministic generated messages. No live transport and no robot data. */
export class Demo {
  topics = new Map<number, Topic>();
  private start = 0;
  private last = -1;
  private cloud: any;
  constructor(private emit: (p: Packet) => void) {
    types.forEach((type, i) =>
      this.topics.set(i, {
        id: i,
        topic: names[i],
        schemaName: type,
        encoding: "ros1",
        schema: "",
        enabled: true,
        supported: true,
        received: 0,
        bytes: 0,
        lastAt: 0,
      }),
    );
    this.cloud = this.makeCloud();
  }
  private send(id: number, message: any, time = 100) {
    const topic = this.topics.get(id)!;
    if (!topic.enabled) return;
    topic.received++;
    topic.lastAt = performance.now();
    this.emit({ topic, message, time: BigInt(Math.round(time * 1e9)) });
  }
  init(now: number) {
    this.start = now;
    this.last = -1;
    this.send(1, {
      transforms: [
        {
          header: header("base_link"),
          child_frame_id: "laser",
          transform: { translation: point(0, 0, 0.6), rotation: q() },
        },
      ],
    });
    const width = 100,
      height = 80,
      resolution = 0.2,
      data = new Int8Array(width * height);
    data.fill(-1);
    for (let y = 3; y < 77; y++)
      for (let x = 3; x < 97; x++) {
        const edge = x < 5 || x > 94 || y < 5 || y > 74,
          obstacle =
            (x > 22 && x < 34 && y > 20 && y < 31) ||
            (x > 67 && x < 82 && y > 46 && y < 58);
        data[y * width + x] = edge || obstacle ? 100 : 0;
      }
    this.send(2, {
      header: header(),
      info: { width, height, resolution, origin: pose(-10, -8) },
      data,
    });
    const poses = [];
    for (let i = 0; i <= 180; i++) {
      const a = (i / 180) * Math.PI * 2;
      poses.push({
        header: header(),
        pose: pose(5 * Math.cos(a), 3.6 * Math.sin(a), 0.04, a + Math.PI / 2),
      });
    }
    this.send(4, { header: header(), poses });
    this.send(6, {
      markers: [
        {
          header: header("base_link", 0),
          ns: "robot",
          id: 1,
          type: 1,
          action: 0,
          pose: pose(0, 0, 0.2),
          scale: point(0.8, 0.55, 0.4),
          color: { r: 0.12, g: 0.8, b: 0.83, a: 1 },
          frame_locked: true,
        },
        {
          header: header("base_link", 0),
          ns: "robot",
          id: 2,
          type: 0,
          action: 0,
          pose: pose(0.4, 0, 0.45),
          scale: point(0.65, 0.1, 0.2),
          color: { r: 1, g: 0.73, b: 0.3, a: 1 },
          frame_locked: true,
        },
        {
          header: header("map", 0),
          ns: "label",
          id: 1,
          type: 9,
          action: 0,
          pose: pose(-5.6, -3.2, 1.8),
          scale: point(1, 1, 0.65),
          color: { r: 0.6, g: 0.9, b: 1, a: 1 },
          text: "OFFLINE DEMO",
        },
        {
          header: header("map", 0),
          ns: "obstacle",
          id: 1,
          type: 1,
          action: 0,
          pose: pose(-4.3, -2.9, 0.65),
          scale: point(2.4, 2, 1.3),
          color: { r: 0.24, g: 0.36, b: 0.45, a: 0.85 },
        },
        {
          header: header("map", 0),
          ns: "obstacle",
          id: 2,
          type: 1,
          action: 0,
          pose: pose(5, 2.5, 0.9),
          scale: point(2.6, 2, 1.8),
          color: { r: 0.28, g: 0.38, b: 0.46, a: 0.85 },
        },
      ],
    });
    this.tick(now);
  }
  tick(now: number) {
    const elapsed = Math.floor((now - this.start) / 125) / 8;
    if (elapsed === this.last) return;
    this.last = elapsed;
    const time = 100 + elapsed,
      a = elapsed * 0.16,
      x = 5 * Math.cos(a),
      y = 3.6 * Math.sin(a),
      heading = Math.atan2(3.6 * Math.cos(a), -5 * Math.sin(a));
    this.send(
      0,
      {
        transforms: [
          {
            header: header("map", time),
            child_frame_id: "base_link",
            transform: { translation: point(x, y, 0), rotation: q(heading) },
          },
        ],
      },
      time,
    );
    this.send(
      5,
      {
        header: header("map", time),
        child_frame_id: "base_link",
        pose: { pose: pose(x, y, 0.05, heading) },
      },
      time,
    );
    this.send(3, { ...this.cloud, header: header("map", time) }, time);
    const width = 320,
      height = 180,
      data = new Uint8Array(width * height * 3);
    for (let py = 0; py < height; py++)
      for (let px = 0; px < width; px++) {
        const i = (py * width + px) * 3,
          horizon = py < 82;
        data[i] = horizon ? 20 : 45;
        data[i + 1] = horizon ? 48 : 62;
        data[i + 2] = horizon ? 73 : 72;
        if (
          py > 82 &&
          ((px + Math.round(elapsed * 8)) % 64 < 2 || py % 28 < 2)
        ) {
          data[i] = 85;
          data[i + 1] = 150;
          data[i + 2] = 157;
        }
        if ((px - 160) ** 2 + (py - 94) ** 2 < 190) {
          data[i] = 255;
          data[i + 1] = 184;
          data[i + 2] = 69;
        }
      }
    this.send(
      7,
      {
        header: header("camera", time),
        width,
        height,
        encoding: "rgb8",
        is_bigendian: 0,
        step: width * 3,
        data,
      },
      time,
    );
  }
  private makeCloud() {
    const points: number[] = [];
    let seed = 13;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 16000; i++) {
      const side = i % 4,
        t = random(),
        z = random() * 2.6;
      const x = side < 2 ? t * 19 - 9.5 : side === 2 ? -9.5 : 9.5,
        y = side >= 2 ? t * 15 - 7.5 : side === 0 ? -7.5 : 7.5;
      points.push(x, y, z);
    }
    for (let i = 0; i < 6500; i++) {
      const x = random() * 19 - 9.5,
        y = random() * 15 - 7.5;
      points.push(x, y, random() * 0.025);
    }
    const data = new Uint8Array(points.length * 4);
    const view = new DataView(data.buffer);
    points.forEach((v, i) => view.setFloat32(i * 4, v, true));
    return {
      height: 1,
      width: points.length / 3,
      fields: [
        { name: "x", offset: 0, datatype: 7, count: 1 },
        { name: "y", offset: 4, datatype: 7, count: 1 },
        { name: "z", offset: 8, datatype: 7, count: 1 },
      ],
      is_bigendian: false,
      point_step: 12,
      row_step: data.length,
      data,
      is_dense: true,
    };
  }
}
