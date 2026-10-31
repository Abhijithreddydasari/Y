"""TypeSafe compatibility entrypoint; transport lives in learning.decisions."""
from .decisions import DecisionResponse as JevResponse, ProviderFailure, SystemOneClient


class JevClient(SystemOneClient):
    """Pinned TypeSafe client; retained for explicit Jev integrations."""
