import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


def create_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {"User-Agent": "brouter-python-ui/0.3", "Accept": "application/json"}
    )
    adapter = HTTPAdapter(
        max_retries=Retry(
            total=1,
            connect=1,
            read=0,
            status=1,
            backoff_factor=0.2,
            status_forcelist=(429, 502, 503, 504),
            allowed_methods=frozenset({"GET"}),
        )
    )
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def query_overpass(
    session: requests.Session,
    endpoints: list[str] | tuple[str, ...],
    query: str,
    timeout_s: float,
) -> dict:
    last_error = None
    for endpoint in endpoints:
        try:
            response = session.post(endpoint, data={"data": query}, timeout=timeout_s)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as exc:
            last_error = exc
    raise last_error or requests.exceptions.RequestException("All Overpass endpoints failed")
