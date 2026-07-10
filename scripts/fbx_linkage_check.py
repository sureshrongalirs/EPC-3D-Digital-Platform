#!/usr/bin/env python3
"""Independent, struct-level ground-truth parser for the Kaydara FBX Binary format.

This exists purely to cross-verify server/worker/src/adapters/fbx/linkage.ts's
parseFBXLinkages() against a second, from-scratch implementation in a different language --
self-consistency of one parser proves nothing about correctness. It deliberately does not
share any code or helper library with the TypeScript version.

Usage:
    python3 scripts/fbx_linkage_check.py <path-to-fbx-file>

Prints a JSON object of {nodeName: linkageKey} to stdout. Exits non-zero (with a message on
stderr) if the file's magic header doesn't match or the node tree can't be parsed.
"""
import json
import struct
import sys
import zlib

MAGIC = b"Kaydara FBX Binary" + b"  " + b"\x00"  # 21 bytes


class Cursor:
    def __init__(self, buf: bytes):
        self.buf = buf
        self.offset = 0

    def u8(self) -> int:
        v = self.buf[self.offset]
        self.offset += 1
        return v

    def u32(self) -> int:
        v = struct.unpack_from("<I", self.buf, self.offset)[0]
        self.offset += 4
        return v

    def u64(self) -> int:
        v = struct.unpack_from("<Q", self.buf, self.offset)[0]
        self.offset += 8
        return v

    def i16(self) -> int:
        v = struct.unpack_from("<h", self.buf, self.offset)[0]
        self.offset += 2
        return v

    def i32(self) -> int:
        v = struct.unpack_from("<i", self.buf, self.offset)[0]
        self.offset += 4
        return v

    def i64(self) -> int:
        v = struct.unpack_from("<q", self.buf, self.offset)[0]
        self.offset += 8
        return v

    def f32(self) -> float:
        v = struct.unpack_from("<f", self.buf, self.offset)[0]
        self.offset += 4
        return v

    def f64(self) -> float:
        v = struct.unpack_from("<d", self.buf, self.offset)[0]
        self.offset += 8
        return v

    def bytes(self, n: int) -> bytes:
        v = self.buf[self.offset:self.offset + n]
        self.offset += n
        return v


class FBXNode:
    __slots__ = ("name", "properties", "children")

    def __init__(self, name, properties, children):
        self.name = name
        self.properties = properties
        self.children = children


# Array-typed properties ('f','d','l','i','b') always use 32-bit header fields (ArrayLength,
# Encoding, CompressedLength), even inside a >=7500 file where the surrounding node-record
# header itself has switched to 64-bit fields.
def read_array_property(cursor: Cursor, element_size: int):
    array_length = cursor.u32()
    encoding = cursor.u32()
    compressed_length = cursor.u32()
    raw = cursor.bytes(compressed_length)
    payload = zlib.decompress(raw) if encoding == 1 else raw
    if len(payload) != array_length * element_size:
        raise ValueError(
            f"FBX array property length mismatch: expected {array_length * element_size} bytes, got {len(payload)}"
        )
    return payload


def read_property(cursor: Cursor):
    type_code = chr(cursor.u8())
    if type_code == "Y":
        return cursor.i16()
    if type_code == "C":
        return cursor.u8() != 0
    if type_code == "I":
        return cursor.i32()
    if type_code == "F":
        return cursor.f32()
    if type_code == "D":
        return cursor.f64()
    if type_code == "L":
        return cursor.i64()
    if type_code == "f":
        return read_array_property(cursor, 4)
    if type_code == "d":
        return read_array_property(cursor, 8)
    if type_code == "l":
        return read_array_property(cursor, 8)
    if type_code == "i":
        return read_array_property(cursor, 4)
    if type_code == "b":
        return read_array_property(cursor, 1)
    if type_code == "S":
        length = cursor.u32()
        return cursor.bytes(length).decode("utf-8")
    if type_code == "R":
        length = cursor.u32()
        return cursor.bytes(length)
    raise ValueError(f"unknown FBX property type code {type_code!r} (0x{ord(type_code):x})")


def read_node(cursor: Cursor, is64: bool):
    end_offset = cursor.u64() if is64 else cursor.u32()
    num_properties = cursor.u64() if is64 else cursor.u32()
    property_list_len = cursor.u64() if is64 else cursor.u32()
    name_len = cursor.u8()

    if end_offset == 0 and num_properties == 0 and property_list_len == 0 and name_len == 0:
        return None

    name = cursor.bytes(name_len).decode("latin1")

    properties_start = cursor.offset
    properties = [read_property(cursor) for _ in range(num_properties)]
    if cursor.offset != properties_start + property_list_len:
        raise ValueError(
            f"FBX node {name!r}: property list length mismatch "
            f"(expected to consume {property_list_len} bytes, consumed {cursor.offset - properties_start})"
        )

    children = []
    while cursor.offset < end_offset:
        child = read_node(cursor, is64)
        if child is None:
            break
        children.append(child)
    cursor.offset = end_offset

    return FBXNode(name, properties, children)


def parse_fbx_binary(buf: bytes):
    if buf[:len(MAGIC)] != MAGIC:
        raise ValueError("not a Kaydara FBX Binary file (magic header mismatch)")

    cursor = Cursor(buf)
    cursor.offset = 23  # magic (21 bytes) + 2 unknown bytes
    version = cursor.u32()
    is64 = version >= 7500

    nodes = []
    while cursor.offset + 13 <= len(buf):
        node = read_node(cursor, is64)
        if node is None:
            break
        nodes.append(node)

    return version, nodes


def find_children(node: FBXNode, name: str):
    return [c for c in node.children if c.name == name]


def split_compound_name(raw: str) -> str:
    sep = raw.find("\x00\x01")
    return raw if sep == -1 else raw[:sep]


def find_linkages_value(model_node: FBXNode):
    properties70 = next((c for c in model_node.children if c.name == "Properties70"), None)
    if properties70 is None:
        return None
    for p in find_children(properties70, "P"):
        if not p.properties or p.properties[0] != "Linkages":
            continue
        value = p.properties[-1]
        if isinstance(value, str):
            return value
    return None


def parse_fbx_linkages(buf: bytes) -> dict:
    _version, nodes = parse_fbx_binary(buf)
    result = {}

    objects = next((n for n in nodes if n.name == "Objects"), None)
    if objects is None:
        return result

    for model in find_children(objects, "Model"):
        if len(model.properties) < 2 or not isinstance(model.properties[1], str):
            continue
        node_name = split_compound_name(model.properties[1])
        linkage_key = find_linkages_value(model)
        if linkage_key is not None:
            result[node_name] = linkage_key

    return result


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: fbx_linkage_check.py <path-to-fbx-file>", file=sys.stderr)
        return 2

    with open(sys.argv[1], "rb") as f:
        buf = f.read()

    try:
        result = parse_fbx_linkages(buf)
    except Exception as exc:  # noqa: BLE001 -- top-level CLI error reporting
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
