"""Update string values in a Windows executable's RT_VERSION resource."""

from __future__ import annotations

import ctypes
import struct
import sys
from ctypes import wintypes
from pathlib import Path


RT_VERSION = 16
RESOURCE_ID = 1
LANG_EN_US = 1033
LOAD_LIBRARY_AS_DATAFILE = 2


def align4(value: int) -> int:
    return (value + 3) & ~3


def read_utf16_key(data: bytes, position: int, end: int) -> tuple[str, int]:
    chars = bytearray()
    while position + 2 <= end:
        unit = data[position : position + 2]
        position += 2
        if unit == b"\0\0":
            return chars.decode("utf-16le"), position
        chars.extend(unit)
    raise ValueError("unterminated version-resource key")


def parse_block(data: bytes, offset: int = 0) -> tuple[dict, int]:
    length, value_length, value_type = struct.unpack_from("<HHH", data, offset)
    if length < 6 or offset + length > len(data):
        raise ValueError("invalid version-resource block")
    end = offset + length
    key, position = read_utf16_key(data, offset + 6, end)
    position = align4(position)
    value_bytes = value_length * 2 if value_type == 1 else value_length
    value = data[position : position + value_bytes]
    position = align4(position + value_bytes)
    children = []
    while position + 2 <= end:
        child_length = struct.unpack_from("<H", data, position)[0]
        if not child_length:
            break
        child, position = parse_block(data, position)
        children.append(child)
        position = align4(position)
    return {
        "key": key,
        "type": value_type,
        "value_length": value_length,
        "value": value,
        "children": children,
    }, end


def replace_values(node: dict, values: dict[str, str]) -> None:
    if node["key"] in values:
        text = values[node["key"]] + "\0"
        node["type"] = 1
        node["value"] = text.encode("utf-16le")
        node["value_length"] = len(text)
    for child in node["children"]:
        replace_values(child, values)


def build_block(node: dict) -> bytes:
    body = bytearray(b"\0" * 6)
    body.extend((node["key"] + "\0").encode("utf-16le"))
    body.extend(b"\0" * (align4(len(body)) - len(body)))
    body.extend(node["value"])
    if node["children"]:
        body.extend(b"\0" * (align4(len(body)) - len(body)))
        for child in node["children"]:
            body.extend(build_block(child))
            body.extend(b"\0" * (align4(len(body)) - len(body)))
    struct.pack_into("<HHH", body, 0, len(body), node["value_length"], node["type"])
    return bytes(body)


def resource_pointer(resource_id: int) -> ctypes.c_void_p:
    return ctypes.c_void_p(resource_id)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: set_version_info.py EXE")
    target = Path(sys.argv[1]).resolve()
    values = {
        "Comments": "Haru Mikage · Japan · 2026.8.15",
        "CompanyName": "Haru Mikage",
        "FileDescription": "Caption assistance",
        "InternalName": "Caption assistance",
        "LegalCopyright": "Copyright © Haru Mikage, Japan · 2026.8.15",
        "OriginalFilename": "Caption assistance.exe",
        "ProductName": "Caption assistance",
    }

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.LoadLibraryExW.argtypes = [wintypes.LPCWSTR, wintypes.HANDLE, wintypes.DWORD]
    kernel32.LoadLibraryExW.restype = wintypes.HMODULE
    kernel32.FindResourceExW.argtypes = [wintypes.HMODULE, ctypes.c_void_p, ctypes.c_void_p, wintypes.WORD]
    kernel32.FindResourceExW.restype = wintypes.HANDLE
    kernel32.LoadResource.argtypes = [wintypes.HMODULE, wintypes.HANDLE]
    kernel32.LoadResource.restype = wintypes.HANDLE
    kernel32.LockResource.argtypes = [wintypes.HANDLE]
    kernel32.LockResource.restype = ctypes.c_void_p
    kernel32.SizeofResource.argtypes = [wintypes.HMODULE, wintypes.HANDLE]
    kernel32.SizeofResource.restype = wintypes.DWORD
    kernel32.FreeLibrary.argtypes = [wintypes.HMODULE]
    kernel32.BeginUpdateResourceW.argtypes = [wintypes.LPCWSTR, wintypes.BOOL]
    kernel32.BeginUpdateResourceW.restype = wintypes.HANDLE
    kernel32.UpdateResourceW.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, wintypes.WORD, ctypes.c_void_p, wintypes.DWORD]
    kernel32.UpdateResourceW.restype = wintypes.BOOL
    kernel32.EndUpdateResourceW.argtypes = [wintypes.HANDLE, wintypes.BOOL]
    kernel32.EndUpdateResourceW.restype = wintypes.BOOL

    module = kernel32.LoadLibraryExW(str(target), None, LOAD_LIBRARY_AS_DATAFILE)
    if not module:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        resource = kernel32.FindResourceExW(module, resource_pointer(RT_VERSION), resource_pointer(RESOURCE_ID), LANG_EN_US)
        if not resource:
            raise ctypes.WinError(ctypes.get_last_error())
        size = kernel32.SizeofResource(module, resource)
        loaded = kernel32.LoadResource(module, resource)
        pointer = kernel32.LockResource(loaded)
        original = ctypes.string_at(pointer, size)
    finally:
        kernel32.FreeLibrary(module)

    tree, _ = parse_block(original)
    replace_values(tree, values)
    updated = build_block(tree)
    update = kernel32.BeginUpdateResourceW(str(target), False)
    if not update:
        raise ctypes.WinError(ctypes.get_last_error())
    buffer = ctypes.create_string_buffer(updated)
    try:
        if not kernel32.UpdateResourceW(update, resource_pointer(RT_VERSION), resource_pointer(RESOURCE_ID), LANG_EN_US, buffer, len(updated)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel32.EndUpdateResourceW(update, False):
            update = None
            raise ctypes.WinError(ctypes.get_last_error())
        update = None
    finally:
        if update:
            kernel32.EndUpdateResourceW(update, True)
    print(f"updated version resource: {target} ({len(original)} -> {len(updated)} bytes)")


if __name__ == "__main__":
    main()
