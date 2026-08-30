/*
 * WowAltBoard - tools/blp.js
 *
 * BLP2 → PNG，零依赖（只用 Node 自带的 zlib）。
 *
 * 为什么需要它：游戏的图标是 BLP2 格式，浏览器不认。国内访问不了 wowhead 的
 * CDN，所以图标只能从本机来 —— 本机 Interface\Icons 下有 22786 个散装 .blp，
 * 解成 PNG 就能直接放进包里离线用。
 *
 * BLP2 头（小端）：
 *   0   char[4]  'BLP2'
 *   4   uint32   version（实测 1）
 *   8   uint8    colorEncoding  1=调色板 2=DXT 3=ARGB8888
 *   9   uint8    alphaSize      0 / 1 / 4 / 8
 *   10  uint8    preferredFormat
 *   11  uint8    hasMips
 *   12  uint32   width
 *   16  uint32   height
 *   20  uint32[16] mipOffsets
 *   84  uint32[16] mipSizes
 *   148 uint32[256] palette（BGRA，DXT 也照样存在，实测头长 1172 = 148+1024）
 *
 * 本机实测：全部 22786 个文件都是 64×64 / colorEncoding 2 / alphaSize 8 /
 * preferredFormat 7 → DXT5。另外两种编码也实现了，因为别处（比如插件自带的
 * media）会用到，而且不实现就等于赌所有输入都长一个样。
 */
'use strict';

var zlib = require('zlib');

// ------------------------------------------------------------------ BLP 解码

function readHeader(buf) {
  if (buf.length < 148) throw new Error('文件太短，不是 BLP2');
  if (buf.toString('latin1', 0, 4) !== 'BLP2') {
    throw new Error('魔数不是 BLP2：' + JSON.stringify(buf.toString('latin1', 0, 4)));
  }
  var h = {
    version: buf.readUInt32LE(4),
    colorEncoding: buf.readUInt8(8),
    alphaSize: buf.readUInt8(9),
    preferredFormat: buf.readUInt8(10),
    hasMips: buf.readUInt8(11),
    width: buf.readUInt32LE(12),
    height: buf.readUInt32LE(16),
    mipOffsets: [],
    mipSizes: []
  };
  for (var i = 0; i < 16; i++) {
    h.mipOffsets.push(buf.readUInt32LE(20 + i * 4));
    h.mipSizes.push(buf.readUInt32LE(84 + i * 4));
  }
  return h;
}

/** RGB565 → [r,g,b]，按 DXT 的常规做法把高位补到低位。 */
function rgb565(v) {
  var r = (v >> 11) & 0x1f, g = (v >> 5) & 0x3f, b = v & 0x1f;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

/**
 * 解一块 BC1 颜色（8 字节）到 4 个 RGBA。
 * c0 > c1 时是 4 色不透明模式；否则第 4 个索引是全透明。
 */
function bc1Colors(buf, at) {
  var c0 = buf.readUInt16LE(at), c1 = buf.readUInt16LE(at + 2);
  var a = rgb565(c0), b = rgb565(c1);
  var t = [[a[0], a[1], a[2], 255], [b[0], b[1], b[2], 255], null, null];
  if (c0 > c1) {
    t[2] = [(2 * a[0] + b[0]) / 3 | 0, (2 * a[1] + b[1]) / 3 | 0, (2 * a[2] + b[2]) / 3 | 0, 255];
    t[3] = [(a[0] + 2 * b[0]) / 3 | 0, (a[1] + 2 * b[1]) / 3 | 0, (a[2] + 2 * b[2]) / 3 | 0, 255];
  } else {
    t[2] = [(a[0] + b[0]) >> 1, (a[1] + b[1]) >> 1, (a[2] + b[2]) >> 1, 255];
    t[3] = [0, 0, 0, 0];
  }
  return t;
}

/** BC4 风格的 8 字节 alpha 块 → 16 个 alpha 值。 */
function bc4Alpha(buf, at) {
  var a0 = buf.readUInt8(at), a1 = buf.readUInt8(at + 1);
  var tbl = [a0, a1, 0, 0, 0, 0, 0, 0];
  if (a0 > a1) {
    for (var i = 1; i <= 6; i++) tbl[i + 1] = ((7 - i) * a0 + i * a1) / 7 | 0;
  } else {
    for (var j = 1; j <= 4; j++) tbl[j + 1] = ((5 - j) * a0 + j * a1) / 5 | 0;
    tbl[6] = 0;
    tbl[7] = 255;
  }
  // 6 字节 = 16 个 3 位索引，低位先出
  var lo = buf.readUIntLE(at + 2, 3);
  var hi = buf.readUIntLE(at + 5, 3);
  var out = new Array(16);
  for (var k = 0; k < 8; k++) out[k] = tbl[(lo >> (3 * k)) & 7];
  for (var k2 = 0; k2 < 8; k2++) out[k2 + 8] = tbl[(hi >> (3 * k2)) & 7];
  return out;
}

/** DXT1/3/5 → RGBA。blockBytes: 8 = DXT1，16 = DXT3/DXT5。 */
function decodeDxt(data, w, h, variant) {
  var out = Buffer.alloc(w * h * 4);
  var blockBytes = variant === 1 ? 8 : 16;
  var bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2);
  var need = bw * bh * blockBytes;
  if (data.length < need) throw new Error('DXT 数据不足：要 ' + need + ' 只有 ' + data.length);

  for (var by = 0; by < bh; by++) {
    for (var bx = 0; bx < bw; bx++) {
      var at = (by * bw + bx) * blockBytes;
      var alpha = null, colorAt = at;
      if (variant === 3) {
        alpha = new Array(16);
        for (var i = 0; i < 8; i++) {
          var b = data.readUInt8(at + i);
          alpha[i * 2] = (b & 0x0f) * 17;
          alpha[i * 2 + 1] = ((b >> 4) & 0x0f) * 17;
        }
        colorAt = at + 8;
      } else if (variant === 5) {
        alpha = bc4Alpha(data, at);
        colorAt = at + 8;
      }
      var pal = bc1Colors(data, colorAt);
      var idx = data.readUInt32LE(colorAt + 4);
      for (var py = 0; py < 4; py++) {
        for (var px = 0; px < 4; px++) {
          var x = bx * 4 + px, y = by * 4 + py;
          if (x >= w || y >= h) continue;
          var n = py * 4 + px;
          var c = pal[(idx >> (2 * n)) & 3];
          var o = (y * w + x) * 4;
          out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
          out[o + 3] = alpha ? alpha[n] : c[3];
        }
      }
    }
  }
  return out;
}

/** colorEncoding 1：调色板索引 + 独立的 alpha 位平面。 */
function decodePalettized(data, w, h, palette, alphaSize) {
  var n = w * h;
  var out = Buffer.alloc(n * 4);
  if (data.length < n) throw new Error('调色板数据不足');
  for (var i = 0; i < n; i++) {
    var p = data.readUInt8(i) * 4;
    // 调色板是 BGRA
    out[i * 4] = palette[p + 2];
    out[i * 4 + 1] = palette[p + 1];
    out[i * 4 + 2] = palette[p];
    out[i * 4 + 3] = 255;
  }
  if (alphaSize === 8) {
    for (var j = 0; j < n; j++) out[j * 4 + 3] = data.readUInt8(n + j);
  } else if (alphaSize === 4) {
    for (var k = 0; k < n; k++) {
      var b = data.readUInt8(n + (k >> 1));
      out[k * 4 + 3] = ((k & 1) ? (b >> 4) : (b & 0x0f)) * 17;
    }
  } else if (alphaSize === 1) {
    for (var m = 0; m < n; m++) {
      var bb = data.readUInt8(n + (m >> 3));
      out[m * 4 + 3] = (bb >> (m & 7)) & 1 ? 255 : 0;
    }
  }
  return out;
}

/** colorEncoding 3：直接就是 BGRA。 */
function decodeRaw(data, w, h) {
  var n = w * h;
  var out = Buffer.alloc(n * 4);
  for (var i = 0; i < n; i++) {
    out[i * 4] = data.readUInt8(i * 4 + 2);
    out[i * 4 + 1] = data.readUInt8(i * 4 + 1);
    out[i * 4 + 2] = data.readUInt8(i * 4);
    out[i * 4 + 3] = data.readUInt8(i * 4 + 3);
  }
  return out;
}

/**
 * BLP2 buffer → {width, height, rgba, info}
 * 只解 mip 0（图标本来就 64×64，用不着更小的）。
 */
function decodeBlp(buf) {
  var h = readHeader(buf);
  var off = h.mipOffsets[0], size = h.mipSizes[0];
  if (!off || !size || off + size > buf.length) {
    throw new Error('mip0 越界：off ' + off + ' size ' + size + ' 文件 ' + buf.length);
  }
  var data = buf.slice(off, off + size);
  var palette = buf.length >= 148 + 1024 ? buf.slice(148, 148 + 1024) : Buffer.alloc(1024);
  var rgba, kind;

  if (h.colorEncoding === 2) {
    var variant;
    if (h.alphaSize <= 1) variant = 1;
    else if (h.preferredFormat === 7) variant = 5;
    else variant = 3;
    kind = 'DXT' + variant;
    rgba = decodeDxt(data, h.width, h.height, variant);
  } else if (h.colorEncoding === 1) {
    kind = '调色板/a' + h.alphaSize;
    rgba = decodePalettized(data, h.width, h.height, palette, h.alphaSize);
  } else if (h.colorEncoding === 3) {
    kind = 'ARGB8888';
    rgba = decodeRaw(data, h.width, h.height);
  } else {
    throw new Error('不认识的 colorEncoding ' + h.colorEncoding);
  }
  return { width: h.width, height: h.height, rgba: rgba, kind: kind, header: h };
}

// ------------------------------------------------------------------ PNG 编码

var CRC_TABLE = (function () {
  var t = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  var c = -1;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * RGBA → PNG（颜色类型 6，8 位）。全部像素不透明时降级成颜色类型 2（RGB），
 * 图标里这种情况不少，能省下四分之一的体积。
 */
function encodePng(width, height, rgba) {
  var opaque = true;
  for (var i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) { opaque = false; break; }
  }
  var ch = opaque ? 3 : 4;
  var raw = Buffer.alloc(height * (1 + width * ch));
  var o = 0;
  for (var y = 0; y < height; y++) {
    raw[o++] = 0;                      // 过滤器 0 = None
    for (var x = 0; x < width; x++) {
      var s = (y * width + x) * 4;
      raw[o++] = rgba[s];
      raw[o++] = rgba[s + 1];
      raw[o++] = rgba[s + 2];
      if (!opaque) raw[o++] = rgba[s + 3];
    }
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;                          // bit depth
  ihdr[9] = opaque ? 2 : 6;             // color type
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function blpToPng(buf) {
  var img = decodeBlp(buf);
  return { png: encodePng(img.width, img.height, img.rgba), info: img };
}

module.exports = {
  readHeader: readHeader,
  decodeBlp: decodeBlp,
  encodePng: encodePng,
  blpToPng: blpToPng,
  crc32: crc32
};

// -------------------------------------------------------------------- CLI
if (require.main === module) {
  var fs = require('fs');
  var a = process.argv.slice(2);
  if (a.length < 1) {
    console.log('用法: node tools\\blp.js <输入.blp> [输出.png]');
    process.exit(2);
  }
  var r = blpToPng(fs.readFileSync(a[0]));
  console.log(r.info.width + '×' + r.info.height + '  ' + r.info.kind +
              '  → PNG ' + r.png.length + ' 字节');
  if (a[1]) { fs.writeFileSync(a[1], r.png); console.log('写出 ' + a[1]); }
}
