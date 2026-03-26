/**
 * PresenceManager — Multi-User Awareness (Phase 2)
 * Tracks connected users, manages build locks, and broadcasts presence updates.
 */

import { logUserEvent } from "../db.js";

export class PresenceManager {
  constructor() {
    // Map<wsId, { id, name, role, status, branch, connectedAt, lastHeartbeat, buildStart }>
    this.users = new Map();
    // Build lock: { userId, userName, branch, acquiredAt } or null
    this.buildLock = null;
    // Lock inactivity timer — auto-release after 5 min of no chat activity
    this._lockTimer = null;
    this.LOCK_INACTIVITY_MS = 5 * 60 * 1000; // 5 minutes
    // Broadcast function — set by server
    this._broadcast = () => {};
    // Heartbeat timeout (ms) — consider user disconnected after this
    this.HEARTBEAT_TIMEOUT = 90000; // 90s (3 missed 30s heartbeats)
    // Cleanup interval
    this._cleanupInterval = setInterval(() => this._cleanup(), 30000);
  }

  /** Set the broadcast function (called by server-washmen.js) */
  setBroadcast(fn) {
    this._broadcast = fn;
  }

  /** User connected — called on ws 'identify' message */
  addUser(wsId, name, role) {
    const user = {
      id: wsId,
      name,
      role: role || "other",
      status: "idle", // idle | active | building
      branch: null,
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      buildStart: null,
    };
    this.users.set(wsId, user);

    logUserEvent(name, role, "connect", null, null, { wsId });
    this._broadcastPresence();
    return user;
  }

  /** User disconnected — called on ws 'close' */
  removeUser(wsId) {
    const user = this.users.get(wsId);
    if (!user) return;

    // If this user held the build lock, release it
    if (this.buildLock?.userId === wsId) {
      this._releaseLock(wsId, "disconnect");
    }

    // Log build duration if they were building
    if (user.buildStart) {
      const duration = Date.now() - user.buildStart;
      logUserEvent(user.name, user.role, "build_end", user.branch, null, {
        duration_ms: duration,
        reason: "disconnect",
      });
    }

    logUserEvent(user.name, user.role, "disconnect", user.branch, null, { wsId });
    this.users.delete(wsId);
    this._broadcastPresence();
  }

  /** Heartbeat received — update last seen */
  heartbeat(wsId) {
    const user = this.users.get(wsId);
    if (user) {
      user.lastHeartbeat = Date.now();
    }
  }

  /** User switched branches */
  switchBranch(wsId, branch) {
    const user = this.users.get(wsId);
    if (!user) return;

    const oldBranch = user.branch;
    user.branch = branch;

    // Release build lock if switching away from locked branch
    if (this.buildLock?.userId === wsId && this.buildLock.branch !== branch) {
      this._releaseLock(wsId, "branch_switch");
    }

    logUserEvent(user.name, user.role, "branch_switch", branch, null, {
      from: oldBranch,
      to: branch,
    });
    this._broadcastPresence();
  }

  /** User sent a chat message */
  onChatSent(wsId, branch, sessionId) {
    const user = this.users.get(wsId);
    if (user) {
      user.status = "active";
      user.branch = branch;
      // Keep the lock alive on every chat message
      if (this.buildLock?.userId === wsId) this._resetLockTimer();
      logUserEvent(user.name, user.role, "chat_sent", branch, sessionId);
    }
  }

  /** Try to acquire build lock for a user */
  acquireLock(wsId) {
    const user = this.users.get(wsId);
    if (!user) return { ok: false, reason: "unknown_user" };

    // If no lock exists, grant it
    if (!this.buildLock) {
      this.buildLock = {
        userId: wsId,
        userName: user.name,
        branch: user.branch,
        acquiredAt: Date.now(),
      };
      user.status = "building";
      user.buildStart = Date.now();

      logUserEvent(user.name, user.role, "build_start", user.branch);
      this._broadcast({
        type: "build_lock_acquired",
        userId: wsId,
        userName: user.name,
        branch: user.branch,
      });
      this._resetLockTimer();
      this._broadcastPresence();
      return { ok: true };
    }

    // If this user already has the lock, refresh inactivity timer
    if (this.buildLock.userId === wsId) {
      this._resetLockTimer();
      return { ok: true };
    }

    // Lock held by someone else
    return {
      ok: false,
      reason: "locked",
      lockedBy: this.buildLock.userName,
      lockedSince: this.buildLock.acquiredAt,
      branch: this.buildLock.branch,
    };
  }

  /** Take over the build lock from another user */
  takeOver(wsId) {
    const user = this.users.get(wsId);
    if (!user) return { ok: false, reason: "unknown_user" };

    const previous = this.buildLock;
    if (previous) {
      // End previous user's build
      const prevUser = this.users.get(previous.userId);
      if (prevUser) {
        const duration = Date.now() - (prevUser.buildStart || previous.acquiredAt);
        logUserEvent(prevUser.name, prevUser.role, "build_end", prevUser.branch, null, {
          duration_ms: duration,
          reason: "taken_over",
          taken_by: user.name,
        });
        prevUser.status = "idle";
        prevUser.buildStart = null;
      }
    }

    // Assign new lock
    this.buildLock = {
      userId: wsId,
      userName: user.name,
      branch: user.branch,
      acquiredAt: Date.now(),
    };
    user.status = "building";
    user.buildStart = Date.now();

    logUserEvent(user.name, user.role, "take_over", user.branch, null, {
      from: previous?.userName || null,
    });

    this._broadcast({
      type: "build_lock_acquired",
      userId: wsId,
      userName: user.name,
      branch: user.branch,
    });
    if (previous) {
      this._broadcast({
        type: "build_lock_released",
        releasedBy: previous.userName,
        takenBy: user.name,
      });
    }
    this._broadcastPresence();
    return { ok: true };
  }

  /** Release the build lock */
  releaseLock(wsId) {
    if (!this.buildLock || this.buildLock.userId !== wsId) {
      return { ok: false, reason: "not_lock_holder" };
    }
    this._releaseLock(wsId, "manual");
    return { ok: true };
  }

  /** Reset the lock inactivity timer — called on acquire and every chat message */
  _resetLockTimer() {
    if (this._lockTimer) clearTimeout(this._lockTimer);
    if (!this.buildLock) return;
    this._lockTimer = setTimeout(() => {
      if (this.buildLock) {
        console.log(`[presence] Lock expired after ${this.LOCK_INACTIVITY_MS / 1000}s inactivity — releasing (${this.buildLock.userName})`);
        this._releaseLock(this.buildLock.userId, "inactivity");
      }
    }, this.LOCK_INACTIVITY_MS);
  }

  /** Internal lock release */
  _releaseLock(wsId, reason) {
    const user = this.users.get(wsId);
    const lockInfo = this.buildLock;
    if (!lockInfo) return;

    if (user) {
      const duration = Date.now() - (user.buildStart || lockInfo.acquiredAt);
      logUserEvent(user.name, user.role, "build_end", user.branch, null, {
        duration_ms: duration,
        reason,
      });
      user.status = "idle";
      user.buildStart = null;
    }

    this._broadcast({
      type: "build_lock_released",
      releasedBy: lockInfo.userName,
      reason,
    });

    this.buildLock = null;
    if (this._lockTimer) { clearTimeout(this._lockTimer); this._lockTimer = null; }
    this._broadcastPresence();
  }

  /** Get current presence state (for REST API) */
  getPresence() {
    const users = [];
    for (const [id, u] of this.users) {
      users.push({
        id,
        name: u.name,
        role: u.role,
        status: u.status,
        branch: u.branch,
        connectedAt: u.connectedAt,
      });
    }
    return {
      users,
      buildLock: this.buildLock
        ? {
            userId: this.buildLock.userId,
            userName: this.buildLock.userName,
            branch: this.buildLock.branch,
            acquiredAt: this.buildLock.acquiredAt,
          }
        : null,
    };
  }

  /** Broadcast presence to all clients */
  _broadcastPresence() {
    const presence = this.getPresence();
    this._broadcast({ type: "presence_update", ...presence });
  }

  /** Cleanup stale connections (missed heartbeats) */
  _cleanup() {
    const now = Date.now();
    const stale = [];
    for (const [wsId, user] of this.users) {
      if (now - user.lastHeartbeat > this.HEARTBEAT_TIMEOUT) {
        stale.push(wsId);
      }
    }
    for (const wsId of stale) {
      const user = this.users.get(wsId);
      if (user) {
        console.log(`[presence] Stale connection: ${user.name} (${wsId}) — removing`);
        logUserEvent(user.name, user.role, "idle", user.branch, null, {
          lastHeartbeat: user.lastHeartbeat,
        });
      }
      this.removeUser(wsId);
    }
  }

  /** Shutdown — clear intervals */
  destroy() {
    clearInterval(this._cleanupInterval);
    if (this._lockTimer) clearTimeout(this._lockTimer);
  }
}
