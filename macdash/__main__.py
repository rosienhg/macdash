import argparse
import logging


def main():
    from . import config

    parser = argparse.ArgumentParser(prog="macdash", description="Headless Mac dashboard")
    parser.add_argument("--host", default=config.HOST)
    parser.add_argument("--port", type=int, default=config.PORT)
    parser.add_argument("--print-token", action="store_true", help="print the access token and exit")
    args = parser.parse_args()

    if args.print_token:
        print(config.TOKEN)
        return

    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    uvicorn.run("macdash.app:app", host=args.host, port=args.port, log_level="warning", proxy_headers=True)


if __name__ == "__main__":
    main()
