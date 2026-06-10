import os
import logging
from pathlib import Path
from typing import Optional

import snowflake.connector
from snowflake.connector import DictCursor

logger = logging.getLogger(__name__)

_connection: Optional[snowflake.connector.SnowflakeConnection] = None

SPCS_TOKEN_PATH = "/snowflake/session/token"


def _is_spcs() -> bool:
    return Path(SPCS_TOKEN_PATH).exists()


def _build_connection_params() -> dict:
    base = {
        "database": os.getenv("SNOWFLAKE_DATABASE", "PMI_CLIPP_POC"),
        "schema": os.getenv("SNOWFLAKE_SCHEMA", "BOM_ANALYTICS"),
        "warehouse": os.getenv("SNOWFLAKE_WAREHOUSE", "BOM_WH"),
    }

    if _is_spcs():
        token = Path(SPCS_TOKEN_PATH).read_text().strip()
        base.update({
            "host": os.environ["SNOWFLAKE_HOST"],
            "account": os.getenv("SNOWFLAKE_ACCOUNT", "snowflake"),
            "authenticator": "oauth",
            "token": token,
        })
    elif os.getenv("SNOWFLAKE_PRIVATE_KEY_PATH"):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.backends import default_backend
        key_path = os.path.expanduser(os.environ["SNOWFLAKE_PRIVATE_KEY_PATH"])
        with open(key_path, "rb") as f:
            private_key = serialization.load_pem_private_key(
                f.read(), password=None, backend=default_backend()
            )
        pkb = private_key.private_bytes(
            serialization.Encoding.DER,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption()
        )
        base.update({
            "account": os.environ["SNOWFLAKE_ACCOUNT"],
            "user": os.environ["SNOWFLAKE_USER"],
            "private_key": pkb,
        })
    elif os.getenv("SNOWFLAKE_AUTHENTICATOR", "").lower() == "externalbrowser":
        base.update({
            "account": os.environ["SNOWFLAKE_ACCOUNT"],
            "user": os.environ["SNOWFLAKE_USER"],
            "authenticator": "externalbrowser",
        })
    else:
        base.update({
            "account": os.environ["SNOWFLAKE_ACCOUNT"],
            "user": os.environ["SNOWFLAKE_USER"],
            "password": os.environ["SNOWFLAKE_PASSWORD"],
        })

    return base


def get_connection() -> snowflake.connector.SnowflakeConnection:
    global _connection

    if _connection is not None:
        try:
            _connection.cursor().execute("SELECT 1")
            return _connection
        except Exception:
            logger.warning("Snowflake connection lost, reconnecting...")
            _connection = None

    params = _build_connection_params()
    _connection = snowflake.connector.connect(**params)
    logger.info("Snowflake connection established")
    return _connection


def execute_query(sql: str, params: dict = None) -> list[dict]:
    conn = get_connection()
    try:
        with conn.cursor(DictCursor) as cur:
            cur.execute(sql, params or {})
            rows = cur.fetchall()
            # Normalize all keys to lowercase so frontend receives consistent casing
            return [{k.lower(): v for k, v in row.items()} for row in rows]
    except Exception as e:
        logger.error("Query failed: %s | SQL: %s", e, sql)
        global _connection
        _connection = None
        raise
