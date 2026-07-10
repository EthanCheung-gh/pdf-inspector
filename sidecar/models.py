from dataclasses import dataclass, field, asdict
from typing import Any, Optional


@dataclass
class PdfObject:
    type: str
    x0: float
    y0: float
    x1: float
    y1: float
    page: int
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {'type': self.type, 'x0': self.x0, 'y0': self.y0,
                'x1': self.x1, 'y1': self.y1, 'page': self.page, **self.extra}


@dataclass
class RpcRequest:
    id: int
    method: str
    params: dict[str, Any]


@dataclass
class RpcResponse:
    id: int
    result: Any = None
    error: Optional[str] = None


def parse_request(line: str) -> RpcRequest:
    import json
    data = json.loads(line)
    return RpcRequest(id=data['id'], method=data['method'], params=data.get('params', {}))


def format_response(resp: RpcResponse) -> str:
    import json
    if resp.error:
        return json.dumps({'id': resp.id, 'error': resp.error}) + '\n'
    return json.dumps({'id': resp.id, 'result': resp.result}) + '\n'
