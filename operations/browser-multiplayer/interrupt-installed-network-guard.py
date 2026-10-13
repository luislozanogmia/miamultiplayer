"""Copied as sitecustomize.py only into the fixture's disposable Python path."""
import ipaddress
import socket

_connect = socket.socket.connect
_connect_ex = socket.socket.connect_ex
_getaddrinfo = socket.getaddrinfo


def allowed(host):
    if host in (None, "localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def connect(self, address):
    if self.family in (socket.AF_INET, socket.AF_INET6) and not allowed(address[0]):
        raise PermissionError("Synthetic fixture blocks non-loopback networking")
    return _connect(self, address)


def connect_ex(self, address):
    if self.family in (socket.AF_INET, socket.AF_INET6) and not allowed(address[0]):
        raise PermissionError("Synthetic fixture blocks non-loopback networking")
    return _connect_ex(self, address)


def getaddrinfo(host, *args, **kwargs):
    if not allowed(host):
        raise PermissionError("Synthetic fixture blocks non-loopback DNS")
    return _getaddrinfo(host, *args, **kwargs)


socket.socket.connect = connect
socket.socket.connect_ex = connect_ex
socket.getaddrinfo = getaddrinfo
