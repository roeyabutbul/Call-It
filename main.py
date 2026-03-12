from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import random
import string
import uuid
import math
import os
import json
import asyncio
from datetime import datetime
from typing import Optional, Dict, List
from cryptography.hazmat.primitives.asymmetric.ec import generate_private_key, SECP256R1
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, PublicFormat, NoEncryption, load_pem_private_key
import base64
from pywebpush import webpush, WebPushException
from py_vapid import Vapid

app = FastAPI()

# In-memory storage
lobbies: Dict[str, dict] = {}
connections: Dict[str, Dict[str, WebSocket]] = {}  # code -> {session_id: websocket}
push_subs: Dict[str, List[dict]] = {}               # code -> [subscription_info, ...]
pending_removals: Dict[str, asyncio.Task] = {}      # f"{code}:{session_id}" -> task


# ── VAPID keys ───────────────────────────────────────────────────────────────

VAPID_KEYS_FILE = "vapid_keys.json"

def load_or_create_vapid_keys() -> dict:
    # Prefer environment variables (used in production on Railway)
    env_private = os.environ.get("VAPID_PRIVATE_KEY")
    env_public  = os.environ.get("VAPID_PUBLIC_KEY")
    if env_private and env_public:
        # Normalize line endings (Railway may store \n as literal backslash-n)
        pem_str = env_private.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n")
        # Re-serialize to guarantee a clean PEM with correct formatting
        key_obj = load_pem_private_key(pem_str.encode(), password=None)
        clean_pem = key_obj.private_bytes(Encoding.PEM, PrivateFormat.TraditionalOpenSSL, NoEncryption()).decode()
        return {"private_pem": clean_pem, "public_key": env_public}

    if os.path.exists(VAPID_KEYS_FILE):
        with open(VAPID_KEYS_FILE) as f:
            return json.load(f)

    private_key = generate_private_key(SECP256R1())
    private_pem = private_key.private_bytes(
        Encoding.PEM, PrivateFormat.TraditionalOpenSSL, NoEncryption()
    ).decode()
    public_bytes = private_key.public_key().public_bytes(
        Encoding.X962, PublicFormat.UncompressedPoint
    )
    public_b64 = base64.urlsafe_b64encode(public_bytes).decode().rstrip("=")

    keys = {"private_pem": private_pem, "public_key": public_b64}
    with open(VAPID_KEYS_FILE, "w") as f:
        json.dump(keys, f)
    return keys

vapid_keys = load_or_create_vapid_keys()
vapid_instance = Vapid.from_pem(vapid_keys["private_pem"].encode())


# ── Helpers ──────────────────────────────────────────────────────────────────

def generate_code():
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=6))


def effective_threshold(lobby: dict) -> int:
    if lobby["threshold"] == -1:
        return math.ceil(len(lobby["members"]) / 2)
    return lobby["threshold"]


def members_list(lobby: dict) -> list:
    """Returns [{id, name}] for all members."""
    return [
        {"id": sid, "name": m["name"]}
        for sid, m in lobby["members"].items()
    ]


def send_push_to_lobby(code: str, payload: dict):
    subs = push_subs.get(code, [])
    print(f"[PUSH] Sending to {len(subs)} subscriber(s) in lobby {code}")
    for sub in subs:
        try:
            webpush(
                subscription_info=sub,
                data=json.dumps(payload),
                vapid_private_key=vapid_instance,
                vapid_claims={"sub": "mailto:barout@barout.app"},
            )
            print(f"[PUSH] Sent OK")
        except WebPushException as e:
            print(f"[PUSH] Error: {e}")


async def remove_member(code: str, session_id: str, reason: str):
    """
    Remove a member from the lobby. Handles:
    - Vote count adjustment
    - Creator transfer
    - Empty lobby cleanup
    - Threshold recalculation and possible auto-trigger
    - Broadcasting member_left to everyone
    """
    if code not in lobbies:
        return
    lobby = lobbies[code]
    if session_id not in lobby["members"]:
        return

    # Cancel any pending grace-period removal for this member
    key = f"{code}:{session_id}"
    if key in pending_removals:
        pending_removals[key].cancel()
        del pending_removals[key]

    member = lobby["members"][session_id]
    had_voted = member["voted"]
    was_creator = session_id == lobby["creator_id"]

    # Remove member
    del lobby["members"][session_id]

    # Adjust vote count
    if had_voted and lobby["status"] == "active":
        lobby["vote_count"] = max(0, lobby["vote_count"] - 1)

    # Transfer creator if needed
    new_creator_id = None
    if was_creator and lobby["members"]:
        new_creator_id = next(iter(lobby["members"]))
        lobby["creator_id"] = new_creator_id

    # Empty lobby — clean up and stop
    if not lobby["members"]:
        del lobbies[code]
        push_subs.pop(code, None)
        connections.pop(code, None)
        return

    t = effective_threshold(lobby)

    await broadcast(code, {
        "type": "member_left",
        "session_id": session_id,
        "reason": reason,
        "member_count": len(lobby["members"]),
        "members": members_list(lobby),
        "threshold": t,
        "threshold_raw": lobby["threshold"],
        "new_creator_id": new_creator_id,
    })

    # If lobby was active, check if removal triggers threshold
    # (majority dropped, existing votes now meet new lower threshold)
    if lobby["status"] == "active" and lobby["vote_count"] >= t and t > 0:
        lobby["status"] = "threshold_reached"
        await broadcast(code, {
            "type": "threshold_reached",
            "total_members": len(lobby["members"]),
        })
        asyncio.get_event_loop().run_in_executor(
            None, send_push_to_lobby, code,
            {"title": "BarOut 🎉", "body": "Time to Go! Your crew is ready to leave."}
        )


async def grace_period_removal(code: str, session_id: str):
    """Wait 2 minutes, then remove the member if they haven't reconnected."""
    await asyncio.sleep(120)
    await remove_member(code, session_id, reason="disconnected")
    pending_removals.pop(f"{code}:{session_id}", None)


# ── Request models ──────────────────────────────────────────────────────────

class CreateRequest(BaseModel):
    name: Optional[str] = None

class JoinRequest(BaseModel):
    name: Optional[str] = None

class ThresholdRequest(BaseModel):
    threshold: int
    session_id: str

class SubscribeRequest(BaseModel):
    subscription: dict


# ── API routes ───────────────────────────────────────────────────────────────

@app.get("/api/vapid-public-key")
async def get_vapid_public_key():
    return {"public_key": vapid_keys["public_key"]}


@app.post("/api/lobby/{code}/subscribe")
async def subscribe_push(code: str, req: SubscribeRequest):
    code = code.upper()
    if code not in lobbies:
        raise HTTPException(404, "Lobby not found")
    push_subs.setdefault(code, []).append(req.subscription)
    return {"ok": True}


@app.post("/api/lobby")
async def create_lobby(req: CreateRequest):
    code = generate_code()
    while code in lobbies:
        code = generate_code()

    session_id = str(uuid.uuid4())
    lobbies[code] = {
        "code": code,
        "threshold": -1,
        "creator_id": session_id,
        "members": {
            session_id: {
                "name": req.name,
                "voted": False,
                "joined_at": datetime.now().isoformat(),
            }
        },
        "vote_count": 0,
        "status": "active",
        "created_at": datetime.now().isoformat(),
    }
    return {"code": code, "session_id": session_id}


@app.post("/api/lobby/{code}/join")
async def join_lobby(code: str, req: JoinRequest):
    code = code.upper()
    if code not in lobbies:
        raise HTTPException(404, "Lobby not found")

    lobby = lobbies[code]
    if lobby["status"] != "active":
        raise HTTPException(400, "This lobby is no longer active")

    session_id = str(uuid.uuid4())
    lobby["members"][session_id] = {
        "name": req.name,
        "voted": False,
        "joined_at": datetime.now().isoformat(),
    }

    t = effective_threshold(lobby)
    await broadcast(code, {
        "type": "member_joined",
        "member_count": len(lobby["members"]),
        "members": members_list(lobby),
        "threshold": t,
        "threshold_raw": lobby["threshold"],
    })

    return {"session_id": session_id, "member_count": len(lobby["members"])}


@app.post("/api/lobby/{code}/vote")
async def cast_vote(code: str, session_id: str):
    code = code.upper()
    if code not in lobbies:
        raise HTTPException(404, "Lobby not found")

    lobby = lobbies[code]
    if lobby["status"] != "active":
        raise HTTPException(400, "Lobby is closed")
    if session_id not in lobby["members"]:
        raise HTTPException(403, "Not a member of this lobby")

    member = lobby["members"][session_id]
    if member["voted"]:
        return {"already_voted": True}

    member["voted"] = True
    lobby["vote_count"] += 1

    if lobby["vote_count"] >= effective_threshold(lobby):
        lobby["status"] = "threshold_reached"
        await broadcast(code, {
            "type": "threshold_reached",
            "total_members": len(lobby["members"]),
        })
        asyncio.get_event_loop().run_in_executor(
            None, send_push_to_lobby, code,
            {"title": "BarOut 🎉", "body": "Time to Go! Your crew is ready to leave."}
        )

    return {"voted": True}


@app.delete("/api/lobby/{code}/vote")
async def cancel_vote(code: str, session_id: str):
    code = code.upper()
    if code not in lobbies:
        raise HTTPException(404, "Lobby not found")

    lobby = lobbies[code]
    if session_id not in lobby["members"]:
        raise HTTPException(403, "Not a member of this lobby")

    if lobby["status"] != "active":
        raise HTTPException(400, "Cannot cancel — the lobby has already closed")

    member = lobby["members"][session_id]
    if not member["voted"]:
        return {"cancelled": False}

    member["voted"] = False
    lobby["vote_count"] -= 1

    await broadcast(code, {"type": "vote_cancelled"})

    return {"cancelled": True}


@app.delete("/api/lobby/{code}/member/{target_id}")
async def kick_or_leave(code: str, target_id: str, requester_id: str):
    code = code.upper()
    if code not in lobbies:
        raise HTTPException(404, "Lobby not found")

    lobby = lobbies[code]

    # Must be either leaving yourself or creator kicking someone
    if requester_id != target_id and requester_id != lobby["creator_id"]:
        raise HTTPException(403, "Only the admin can remove other members")
    if target_id not in lobby["members"]:
        raise HTTPException(404, "Member not found")
    # Creator cannot kick themselves via this endpoint (use leave)
    if requester_id == lobby["creator_id"] and target_id == lobby["creator_id"] and requester_id != target_id:
        raise HTTPException(400, "Use the leave endpoint to remove yourself")

    reason = "left" if requester_id == target_id else "kicked"
    await remove_member(code, target_id, reason=reason)
    return {"ok": True}


@app.patch("/api/lobby/{code}/threshold")
async def update_threshold(code: str, req: ThresholdRequest):
    code = code.upper()
    if code not in lobbies:
        raise HTTPException(404, "Lobby not found")

    lobby = lobbies[code]
    if req.session_id != lobby["creator_id"]:
        raise HTTPException(403, "Only the admin can change the threshold")
    if req.threshold != -1 and req.threshold < 1:
        raise HTTPException(400, "Threshold must be at least 1")
    if req.threshold != -1 and req.threshold > len(lobby["members"]):
        raise HTTPException(400, f"Threshold cannot exceed member count ({len(lobby['members'])})")

    lobby["threshold"] = req.threshold
    t = effective_threshold(lobby)

    await broadcast(code, {
        "type": "threshold_updated",
        "threshold": t,
        "is_majority": req.threshold == -1,
    })

    if lobby["vote_count"] >= t and lobby["status"] == "active":
        lobby["status"] = "threshold_reached"
        await broadcast(code, {
            "type": "threshold_reached",
            "total_members": len(lobby["members"]),
        })
        asyncio.get_event_loop().run_in_executor(
            None, send_push_to_lobby, code,
            {"title": "BarOut 🎉", "body": "Time to Go! Your crew is ready to leave."}
        )

    return {"threshold": t}


@app.get("/api/lobby/{code}")
async def get_lobby(code: str, session_id: Optional[str] = None):
    code = code.upper()
    if code not in lobbies:
        raise HTTPException(404, "Lobby not found")

    lobby = lobbies[code]
    members = lobby["members"]
    has_voted = False
    if session_id and session_id in members:
        has_voted = members[session_id]["voted"]

    return {
        "code": code,
        "threshold": effective_threshold(lobby),
        "threshold_raw": lobby["threshold"],
        "member_count": len(members),
        "members": members_list(lobby),
        "status": lobby["status"],
        "is_creator": session_id == lobby["creator_id"],
        "creator_id": lobby["creator_id"],
        "has_voted": has_voted,
    }


# ── WebSocket ────────────────────────────────────────────────────────────────

@app.websocket("/ws/{code}/{session_id}")
async def websocket_endpoint(websocket: WebSocket, code: str, session_id: str):
    code = code.upper()
    await websocket.accept()

    # Cancel any pending grace-period removal on reconnect
    key = f"{code}:{session_id}"
    if key in pending_removals:
        pending_removals[key].cancel()
        del pending_removals[key]

    connections.setdefault(code, {})[session_id] = websocket
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        if code in connections:
            connections[code].pop(session_id, None)
        # Start grace period — remove after 2 minutes if they don't reconnect
        if code in lobbies and session_id in lobbies[code]["members"]:
            task = asyncio.create_task(grace_period_removal(code, session_id))
            pending_removals[key] = task


async def broadcast(code: str, message: dict):
    if code not in connections:
        return
    dead = []
    for sid, ws in connections[code].items():
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(sid)
    for sid in dead:
        connections[code].pop(sid, None)


# ── Static files (must be last) ───────────────────────────────────────────────
app.mount("/", StaticFiles(directory="static", html=True), name="static")
