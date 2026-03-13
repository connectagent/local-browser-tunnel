import asyncio
import logging
import os
import shutil
import subprocess
import aiohttp

from config import load_config, save_config
from bootstrap import bootstrap
import json
from overrides import RELAY_URL

#RELAY_URL     = os.environ.get("RELAY_URL", RELAY_URL)
CHROME_HOST   = os.environ.get("CHROME_HOST",  "127.0.0.1")
CHROME_PORT   = int(os.environ.get("CHROME_PORT", "5097")) #9222
CHROME_BINARY = os.environ.get("CHROME_BINARY", "")

logging.basicConfig(level=logging.DEBUG, format="[tunnel] %(message)s")
logger = logging.getLogger(__name__)

_chrome_proc: subprocess.Popen | None = None
_chrome_ws:   aiohttp.ClientWebSocketResponse | None = None
_relay_ws:    aiohttp.ClientWebSocketResponse | None = None
_chrome_task: asyncio.Task | None = None


def _find_chrome_binary() -> str:
    if CHROME_BINARY:
        return CHROME_BINARY
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "google-chrome", "google-chrome-stable", "chromium-browser", "chromium",
        "/usr/bin/google-chrome", "/usr/bin/chromium-browser",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    for c in candidates:
        if os.path.isfile(c) or shutil.which(c):
            return c
    raise RuntimeError("Chrome not found. Set CHROME_BINARY env var.")


async def _ensure_chrome() -> None:
    global _chrome_proc
    for _ in range(2):
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(
                    f"http://{CHROME_HOST}:{CHROME_PORT}/json/version",
                    timeout=aiohttp.ClientTimeout(total=1),
                ) as resp:
                    if resp.status == 200:
                        logger.info("Chrome already running on port %d", CHROME_PORT)
                        return
        except Exception:
            pass

    binary = _find_chrome_binary()
    user_data = os.path.join(os.path.expanduser("~"), ".chrome-tunnel3-profile")
    args = [
        binary,
        f"--remote-debugging-port={CHROME_PORT}",
        "--remote-debugging-address=127.0.0.1",
        "--no-first-run",
        "--no-default-browser-check",
        f"--user-data-dir={user_data}",

        '--remote-allow-origins=*',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-translate',
        '--metrics-recording-only',
        '--hide-crash-restore-bubble'
    ]
    logger.info(f"Launching Chrome: {binary} remote-debugging-port:{CHROME_PORT}")
    logger.info(f"{args}")
    _chrome_proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    chrome_host=CHROME_HOST
    chrome_port=CHROME_PORT

    #chrome_host="127.0.0.1"
    #chrome_port=5096
    for _ in range(20):
        await asyncio.sleep(0.5)
        try:
            async with aiohttp.ClientSession() as s:
                async with s.get(
                    f"http://{chrome_host}:{chrome_port}/json/version",
                    timeout=aiohttp.ClientTimeout(total=1),
                ) as resp:
                    if resp.status == 200:
                        logger.info("Chrome started")
                        return
        except asyncio.TimeoutError:
            logger.error(f"Can't launch Chrome: timeout of getting /json/version")
        except Exception as exc:
            logger.error(f"Can't launch Chrome: {exc}")

    raise RuntimeError("Chrome failed to start within 10 seconds")


async def _chrome_to_relay() -> None:
    """Read from the current _chrome_ws and forward to relay until Chrome closes."""
    ws = _chrome_ws  # capture at task start
    async for msg in ws:
        if msg.type == aiohttp.WSMsgType.TEXT:
            logger.debug("chrome->relay  %s", msg.data[:120])
            if _relay_ws and not _relay_ws.closed:
                await _relay_ws.send_str(msg.data)
        elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR):
            break
    logger.info("Chrome disconnected — will reconnect on next command")


async def _connect_chrome(session: aiohttp.ClientSession) -> None:
    global _chrome_ws, _chrome_task

    if _chrome_task and not _chrome_task.done():
        _chrome_task.cancel()
        try:
            await _chrome_task
        except asyncio.CancelledError:
            pass

    await _ensure_chrome()

    async with session.get(
        f"http://{CHROME_HOST}:{CHROME_PORT}/json/version"
    ) as resp:
        info = await resp.json(content_type=None)
    chrome_ws_url = info["webSocketDebuggerUrl"]
    logger.info("Connecting to Chrome: %s", chrome_ws_url)
    _chrome_ws = await session.ws_connect(chrome_ws_url)
    logger.info("Chrome connected")

    _chrome_task = asyncio.create_task(_chrome_to_relay())

import socket
async def run(user_id,token) -> None:
    global _relay_ws

    hostname = socket.gethostname()

    while True:
        relay_ws_url = (
                RELAY_URL.replace("https://", "wss://").replace("http://", "ws://")
                + "/on_connect_simple_tunnel"
                + (f"?token={token}&user_id={user_id}&hostname={hostname}")
        )
        try:
            async with aiohttp.ClientSession() as session:
                #await _connect_chrome(session)

                logger.info("Connecting to relay: %s", relay_ws_url)
                _relay_ws = await session.ws_connect(relay_ws_url)
                logger.info("Relay connected.")

                async for msg in _relay_ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        #check for errors
                        data_dict=json.loads(msg.data)
                        method = data_dict.get("method", "")

                        if method=="error":
                            code = data_dict.get("code", "na")
                            message = data_dict.get("message", "na")
                            logger.error(f"Error from relay: {message} ({code})")
                            if code==401:
                                raise RuntimeError(f"Unauthorized: {message}")

                        # Reconnect Chrome if it died
                        if _chrome_ws is None or _chrome_ws.closed:
                            logger.info("Chrome not connected — reconnecting before forwarding")
                            await _connect_chrome(session)
                        logger.debug("relay->chrome  %s", msg.data[:120])
                        await _chrome_ws.send_str(msg.data)
                    elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR):
                        break

            logger.info("Relay disconnected — retrying in 1s")
        except RuntimeError as re:
            user_id,token,tunnel_url=bootstrap()
            save_config(user_id, token, tunnel_url)
        except Exception as exc:
            logger.warning("Relay connection failed: %s — retrying in 1s", exc)

        await asyncio.sleep(1)


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "--reset":
        from config import clear_config, get_config_path
        clear_config()
        logger.info("Config erased: %s", get_config_path())
        sys.exit(0)

    try:
        conf=load_config()
        if not conf:
            logger.info('No credentials found. Starting authorization flow...')
            user_id,token,tunnel_url=bootstrap()
            save_config(user_id, token, tunnel_url)
            logger.info('Authorization successful! Credentials saved.')
        else:
            user_id=conf['user_id']
            token=conf['token']
        #token="local"
        asyncio.run(run(user_id,token))
    except KeyboardInterrupt:
        logger.info("Stopped")
