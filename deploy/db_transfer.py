"""Copy the BR Stats database to a file and back (no MongoDB tools needed).

  python db_transfer.py export brstats.jsonl.gz --env backend/.env
  python db_transfer.py import brstats.jsonl.gz --env backend/.env [--replace]

The file keeps every collection, including screenshots and learned champion icons.
Import refuses to touch a database that already has data unless --replace is given
(exit code 3), and --replace wipes that database first.
"""
import argparse
import gzip
import os
import sys

from bson import json_util
from pymongo import MongoClient

OPTS = json_util.CANONICAL_JSON_OPTIONS


def connect(args):
    env = {}
    if args.env:
        from dotenv import dotenv_values
        env = dotenv_values(args.env)
    uri = args.uri or env.get("MONGO_URL") or os.environ.get("MONGO_URL") or "mongodb://127.0.0.1:27017"
    name = args.db or env.get("DB_NAME") or os.environ.get("DB_NAME")
    if not name:
        sys.exit("No database name: pass --db or --env with DB_NAME")
    return MongoClient(uri)[name]


def export(db, path):
    counts = {}
    with gzip.open(path, "wt", encoding="utf-8") as f:
        for name in sorted(db.list_collection_names()):
            if name.startswith("system."):
                continue
            for doc in db[name].find():
                f.write(json_util.dumps({"c": name, "d": doc}, json_options=OPTS) + "\n")
                counts[name] = counts.get(name, 0) + 1
    print(f"Exported {sum(counts.values())} documents from {db.name}: " +
          ", ".join(f"{k} {v}" for k, v in counts.items()))


def import_(db, path, replace):
    existing = [n for n in db.list_collection_names() if not n.startswith("system.") and db[n].estimated_document_count()]
    if existing and not replace:
        print(f"{db.name} already has data ({', '.join(existing)}). Use --replace to overwrite it.")
        sys.exit(3)
    if replace:
        for n in db.list_collection_names():
            if not n.startswith("system."):
                db[n].drop()
    batch, counts = {}, {}

    def flush(name):
        if batch.get(name):
            db[name].insert_many(batch[name], ordered=False)
            batch[name] = []

    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            row = json_util.loads(line)
            name = row["c"]
            batch.setdefault(name, []).append(row["d"])
            counts[name] = counts.get(name, 0) + 1
            if len(batch[name]) >= 500:
                flush(name)
    for name in list(batch):
        flush(name)
    print(f"Imported {sum(counts.values())} documents into {db.name}: " +
          ", ".join(f"{k} {v}" for k, v in counts.items()))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action", choices=["export", "import"])
    ap.add_argument("file")
    ap.add_argument("--env", help="a backend .env file to read MONGO_URL and DB_NAME from")
    ap.add_argument("--uri")
    ap.add_argument("--db")
    ap.add_argument("--replace", action="store_true", help="import: wipe the database first")
    args = ap.parse_args()
    db = connect(args)
    if args.action == "export":
        export(db, args.file)
    else:
        import_(db, args.file, args.replace)


if __name__ == "__main__":
    main()
