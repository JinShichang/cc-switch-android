"""Preserve upstream allowlist regexes without literal credential lookalikes."""
import re
import tomllib


GOOGLE_LITERAL = re.compile(r"AIza[A-Za-z0-9_-]{35}")


def prepare_gitleaks_config(text: str) -> str:
    """Use an equivalent singleton class only for confirmed Google allowlists.

    These entries are upstream public/example exclusions, not credentials used
    by the application. Keep the matching language, rule order and all other
    fields intact. An unfamiliar literal outside these exclusions needs review.
    """
    config = tomllib.loads(text)
    rule = next(rule for rule in config["rules"] if rule["id"] == "gcp-api-key")
    for allowlist in rule.get("allowlists", []):
        for pattern in allowlist.get("regexes", []):
            if not GOOGLE_LITERAL.fullmatch(pattern):
                continue
            quoted = f"'''{pattern}'''"
            if quoted not in text:
                raise ValueError("Upstream Google allowlist syntax changed; review before copying")
            # A singleton character class accepts precisely the original 'a'.
            text = text.replace(quoted, f"'''AIz[a]{pattern[4:]}'''")
    if GOOGLE_LITERAL.search(text):
        raise ValueError("Unrecognized Google literal outside the confirmed upstream allowlist")
    return text
