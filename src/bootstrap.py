"""Device authorization flow."""

import logging
import uuid
import webbrowser
import time
import requests
import click 
from colorama import Fore, Style
from overrides import DEFAULT_CONNECT_URL,DEFAULT_POLL_URL

logger = logging.getLogger(__name__)

#DEFAULT_CONNECT_URL = 'http://127.0.0.1:5006/connect'
#DEFAULT_POLL_URL = 'http://127.0.0.1:5006/api/connect/poll'



def wait_for_keypress():
    """Wait for any key press before continuing."""
    print()
    click.pause(f'{Fore.YELLOW}Press any key to close...{Style.RESET_ALL}')


def bootstrap():
    """Get credentials through device authorization flow."""
    device_code = str(uuid.uuid4())
    connect_url=DEFAULT_CONNECT_URL
    poll_url=DEFAULT_POLL_URL
    url = f'{connect_url}?code={device_code}'
    logger.info('Opening browser for authorization...')
    webbrowser.open(url)

    print()
    logger.info('Waiting for approval in browser...')
    logger.info('If browser did not open, go to: %s', url)
    print()

    for _ in range(150):
        time.sleep(1)
        try:
            resp = requests.get(f'{poll_url}?code={device_code}', timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                print(data['token'])
                return data['user_id'], data['token'], data['tunnel_url']
            elif resp.status_code == 410:
                raise RuntimeError('Authorization expired. Please restart.')
        except Exception as e:
            logger.debug('Poll failed: %s', e)
    wait_for_keypress()
    raise RuntimeError('Authorization timeout. Please restart.')
if __name__ == "__main__":
    print(bootstrap())
