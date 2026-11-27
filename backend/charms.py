"""The shop's charm chart (charm-chart.jpg): 55 numbered charms, the same for every product that takes a charm.

Customers may give a number ("charm 52", "no. 7") or a name ("Om", "CA", "heart"). A name that fits one charm becomes
its number; a name that fits several (crown = 2, 3 or 4) needs the customer to pick the number.
Charms are saved and printed as "52 (Om)".
"""
from __future__ import annotations

import re
from typing import Dict, List, Optional, Tuple

# number -> (name shown, words a customer might use)
CHARMS: Dict[int, Tuple[str, Tuple[str, ...]]] = {
    1: ("Aeroplane", ("aeroplane", "airplane", "plane", "jahaj")),
    2: ("Crown", ("crown", "taj")),
    3: ("Crown", ("crown", "taj")),
    4: ("Crown", ("crown", "taj")),
    5: ("Infinity love", ("infinity",)),
    6: ("Moustache", ("moustache", "mustache", "mooch", "much")),
    7: ("Anchor with crest", ("anchor",)),
    8: ("Moustache", ("moustache", "mustache", "mooch", "much")),
    9: ("Doctor symbol", ("doctor", "dr symbol", "medical", "caduceus")),
    10: ("Pistol", ("pistol", "gun", "bandook")),
    11: ("Camera", ("camera",)),
    12: ("Love (script)", ("love",)),
    13: ("Love (script)", ("love",)),
    14: ("Pirate skull", ("skull", "pirate")),
    15: ("Anchor", ("anchor",)),
    16: ("Horse", ("horse", "ghoda", "unicorn")),
    17: ("Anchor", ("anchor",)),
    18: ("Sunglasses", ("sunglasses", "goggles", "glasses", "chashma")),
    19: ("Heart love", ("love", "heart love")),
    20: ("Eiffel tower", ("eiffel", "tower", "paris")),
    21: ("Moustache", ("moustache", "mustache", "mooch", "much")),
    22: ("Bike", ("bike", "motorcycle", "motorbike")),
    23: ("Camera", ("camera",)),
    24: ("Elephant", ("elephant", "hathi", "ganesh")),
    25: ("Peace", ("peace",)),
    26: ("Moustache", ("moustache", "mustache", "mooch", "much")),
    27: ("Wing", ("wing", "feather")),
    28: ("Glasses", ("glasses", "specs", "spectacles", "chashma")),
    29: ("Compass", ("compass",)),
    30: ("Pilot wings", ("pilot", "wings")),
    31: ("Mr", ("mr",)),
    32: ("Mrs", ("mrs",)),
    33: ("Spectacles", ("glasses", "specs", "spectacles", "chashma")),
    34: ("Scooter", ("scooter", "scooty", "vespa")),
    35: ("Aeroplane", ("aeroplane", "airplane", "plane", "jahaj")),
    36: ("Fairy", ("fairy", "angel", "pari")),
    37: ("Guitar", ("guitar",)),
    38: ("Jeep", ("jeep", "thar", "car")),
    39: ("Car", ("car", "vintage car")),
    40: ("Aeroplane", ("aeroplane", "airplane", "plane", "jahaj")),
    41: ("Robot", ("robot",)),
    42: ("Brooch", ("brooch", "broach", "brouch")),
    43: ("Music note", ("music", "note", "clef")),
    44: ("Bow", ("bow", "ribbon")),
    45: ("I love you", ("i love you", "ily")),
    46: ("Red heart", ("heart", "dil", "red heart")),
    47: ("India flag", ("flag", "india", "tiranga", "jhanda")),
    48: ("Football", ("football", "soccer")),
    49: ("Bike (big)", ("bike", "motorcycle", "bullet", "harley")),
    50: ("Rose", ("rose", "flower", "gulab")),
    51: ("Hashtag", ("hashtag", "#")),
    52: ("Om", ("om", "ॐ")),
    53: ("CA", ("ca",)),
    54: ("Vakeel (वकील)", ("vakeel", "vakil", "वकील", "advocate", "lawyer", "adv")),
    55: ("Advocate", ("advocate", "lawyer", "adv")),
}
_NUM = re.compile(r"(?<![\d/.-])(\d{1,2})(?![\d/.-])")


def label(n: int) -> str:
    return f"{n} ({CHARMS[n][0]})"


def resolve(value: str) -> Tuple[Optional[str], List[int]]:
    """('52 (Om)', []) when clear; (None, [2, 3, 4]) when the customer must pick; (None, []) when not a chart charm."""
    v = (value or "").strip()
    if not v:
        return None, []
    if v.lower().startswith("logo"):
        return v, []  # a keychain logo sent as a photo
    nums = [int(x) for x in _NUM.findall(v) if 1 <= int(x) <= len(CHARMS)]
    if len(set(nums)) == 1:
        return label(nums[0]), []
    words = re.sub(r"[^\wऀ-ॿ# ]+", " ", v.lower()).split()
    text = " " + " ".join(words) + " "
    hits = [n for n, (_name, keys) in CHARMS.items() if any(f" {k} " in text for k in keys)]
    if len(hits) == 1:
        return label(hits[0]), []
    if hits:
        # a longer, more specific word wins ("red heart" -> 46, "heart love" -> 19)
        best = max(max(len(k) for k in CHARMS[n][1] if f" {k} " in text) for n in hits)
        exact = [n for n in hits if any(len(k) == best and f" {k} " in text for k in CHARMS[n][1])]
        if len(exact) == 1:
            return label(exact[0]), []
        return None, sorted(exact)
    return None, []


def chart_text() -> str:
    """The chart as one line for the AI (names only, so it can turn a name into a number)."""
    return "; ".join(f"{n} {name}" for n, (name, _k) in CHARMS.items())
