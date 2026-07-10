#!/usr/bin/env python3
import sys
import json
import traceback

from models import parse_request, format_response, RpcResponse
from extractor import PdfExtractor
from cache import PageCache


def main():
    extractor: PdfExtractor | None = None
    cache = PageCache(max_pages=10)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = parse_request(line)
        except (json.JSONDecodeError, KeyError) as e:
            sys.stderr.write(f'Parse error: {e}\n')
            sys.stderr.flush()
            continue

        try:
            if req.method == 'open':
                path = req.params['path']
                password = req.params.get('password')
                extractor = PdfExtractor(path, password)
                meta = extractor.get_metadata()
                resp = format_response(RpcResponse(id=req.id, result=meta))

            elif req.method == 'extract_page':
                if extractor is None:
                    resp = format_response(RpcResponse(id=req.id, error='No PDF open'))
                else:
                    page_num = req.params['page']
                    cached = cache.get(page_num)
                    if cached:
                        resp = format_response(RpcResponse(id=req.id, result=cached))
                    else:
                        data = extractor.extract_page(page_num)
                        cache.put(page_num, data)
                        resp = format_response(RpcResponse(id=req.id, result=data))

            elif req.method == 'extract_metadata':
                if extractor is None:
                    resp = format_response(RpcResponse(id=req.id, error='No PDF open'))
                else:
                    meta = extractor.get_metadata()
                    resp = format_response(RpcResponse(id=req.id, result=meta))

            elif req.method == 'get_image_data':
                if extractor is None:
                    resp = format_response(RpcResponse(id=req.id, error='No PDF open'))
                else:
                    image_data = extractor.get_image_data(req.params['stream_id'])
                    resp = format_response(RpcResponse(id=req.id, result=image_data))

            elif req.method == 'shutdown':
                resp = format_response(RpcResponse(id=req.id, result={}))
                sys.stdout.write(resp)
                sys.stdout.flush()
                break

            else:
                resp = format_response(RpcResponse(id=req.id, error=f'Unknown method: {req.method}'))

        except Exception as e:
            sys.stderr.write(traceback.format_exc())
            sys.stderr.flush()
            resp = format_response(RpcResponse(id=req.id, error=str(e)))

        sys.stdout.write(resp)
        sys.stdout.flush()


if __name__ == '__main__':
    main()
