const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const REVIVE_COST = 100;

const LIMITS = {
  maxKillsPerRun: 3000,
  maxShotsPerRun: 20000,
  maxDistKmPerRun: 500,
  maxCoinsPerRun: 5000,
  maxIcePerRun: 200,
  maxKillShotRatio: 2.5,
  minShotsWhenKills: 1,
  maxGamesPerHour: 40,
  maxKillsPerMinute: 120,
  maxKmPerMinute: 15,
  maxBankCoins: 10000000,
};

const TELEGRAM_USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_]{3,30}[A-Za-z0-9])$/;

function httpsError(code, message) {
  return new functions.https.HttpsError(code, message);
}

function normalizeNickname(value) {
  return String(value || '').trim().replace(/^@+/, '');
}

function assertRunSanity(run) {
  const kills = run.kills | 0;
  const shots = run.shots | 0;
  const distKm = Number(run.distKm) || 0;
  const coins = run.coins | 0;
  const icePickups = run.icePickups | 0;
  const durationMs = Math.max(0, run.durationMs | 0);

  if (kills < 0 || kills > LIMITS.maxKillsPerRun) {
    throw httpsError('invalid-argument', 'kills out of range');
  }
  if (shots < 0 || shots > LIMITS.maxShotsPerRun) {
    throw httpsError('invalid-argument', 'shots out of range');
  }
  if (kills > 0 && shots < LIMITS.minShotsWhenKills) {
    throw httpsError('failed-precondition', 'kills without shots');
  }
  if (shots > 0 && kills / shots > LIMITS.maxKillShotRatio) {
    throw httpsError('failed-precondition', 'impossible kill/shot ratio');
  }
  if (distKm < 0 || distKm > LIMITS.maxDistKmPerRun) {
    throw httpsError('invalid-argument', 'distKm out of range');
  }
  if (coins < 0 || coins > LIMITS.maxCoinsPerRun) {
    throw httpsError('invalid-argument', 'coins out of range');
  }
  if (icePickups < 0 || icePickups > LIMITS.maxIcePerRun) {
    throw httpsError('invalid-argument', 'icePickups out of range');
  }

  const minutes = Math.max(durationMs / 60000, 1 / 60);
  if (kills / minutes > LIMITS.maxKillsPerMinute) {
    throw httpsError('failed-precondition', 'kills per minute too high');
  }
  if (distKm / minutes > LIMITS.maxKmPerMinute) {
    throw httpsError('failed-precondition', 'distance per minute too high');
  }

  return { kills, shots, distKm, coins, icePickups, durationMs };
}

function assertLifetimeRatio(totalKills, totalShots) {
  if (totalShots > 0 && totalKills / totalShots > LIMITS.maxKillShotRatio) {
    throw httpsError('failed-precondition', 'lifetime kill/shot ratio invalid');
  }
}

function hasPersistedBankCoins(data) {
  const raw = data && data.bankCoins;
  return raw != null && Number.isFinite(Number(raw));
}

function computeMigrationBankCoins(prev, localBank) {
  const lifetime = Math.max(0, Number(prev.lifetimeCoinsCollected) || 0);
  const revives = Math.max(0, Number(prev.totalRevives) || 0);
  const games = Math.max(0, Number(prev.gamesPlayed) || 0);
  const estimated = Math.max(0, lifetime - revives * REVIVE_COST);
  const local = Math.max(0, localBank | 0);
  const lifetimeCap = lifetime > 0
    ? lifetime
    : Math.min(LIMITS.maxBankCoins, LIMITS.maxCoinsPerRun * Math.max(1, games));
  return Math.min(Math.max(local, estimated), lifetimeCap, LIMITS.maxBankCoins);
}

async function applyBankCoinsMigration(playerRef, prev, localBank) {
  if (hasPersistedBankCoins(prev)) {
    return {
      migrated: false,
      bankCoins: Math.max(0, Number(prev.bankCoins) | 0),
    };
  }

  const bankCoins = computeMigrationBankCoins(prev, localBank);
  await playerRef.set({
    bankCoins,
    bankCoinsMigrated: true,
    bankCoinsMigratedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return { migrated: true, bankCoins };
}

exports.registerPlayer = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw httpsError('unauthenticated', 'Login required');
  }

  const nickname = normalizeNickname(data && data.nickname);
  if (!TELEGRAM_USERNAME_RE.test(nickname)) {
    throw httpsError('invalid-argument', 'invalid nickname');
  }

  const uid = context.auth.uid;
  const nicknameLower = nickname.toLowerCase();
  const playerRef = db.collection('players').doc(uid);

  await db.runTransaction(async (tx) => {
    const existingSnap = await tx.get(playerRef);
    if (existingSnap.exists) {
      const existing = existingSnap.data();
      if (existing.nicknameLower && existing.nicknameLower !== nicknameLower) {
        throw httpsError('already-exists', 'profile already registered');
      }
      if (existing.nicknameLower === nicknameLower) {
        return;
      }
    }

    const dupSnap = await tx.get(
      db.collection('players').where('nicknameLower', '==', nicknameLower).limit(1)
    );
    if (!dupSnap.empty && dupSnap.docs[0].id !== uid) {
      throw httpsError('already-exists', 'nickname taken');
    }

    tx.set(playerRef, {
      nickname,
      nicknameUpper: nickname.toUpperCase(),
      nicknameLower,
      kills: 0,
      distKm: 0,
      gamesPlayed: 0,
      totalKills: 0,
      totalDistKm: 0,
      totalShots: 0,
      totalRevives: 0,
      totalIcePickups: 0,
      lifetimeCoinsCollected: 0,
      bankCoins: 0,
      recentRunAts: [],
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  return { ok: true, nickname };
});

exports.submitGameRun = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw httpsError('unauthenticated', 'Login required');
  }

  const run = assertRunSanity({
    kills: data && data.kills,
    shots: data && data.shots,
    distKm: data && data.distKm,
    coins: data && data.coins,
    icePickups: data && data.icePickups,
    durationMs: data && data.durationMs,
  });

  const uid = context.auth.uid;
  const playerRef = db.collection('players').doc(uid);
  const hourAgo = admin.firestore.Timestamp.fromMillis(Date.now() - 3600000);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(playerRef);
    if (!snap.exists) {
      throw httpsError('failed-precondition', 'player profile missing');
    }

    const prev = snap.data();
    const recentRuns = (prev.recentRunAts || []).filter((t) => t.toMillis() > hourAgo.toMillis());
    if (recentRuns.length >= LIMITS.maxGamesPerHour) {
      throw httpsError('resource-exhausted', 'too many games per hour');
    }

    const newTotalKills = (Number(prev.totalKills) || 0) + run.kills;
    const newTotalShots = (Number(prev.totalShots) || 0) + run.shots;
    assertLifetimeRatio(newTotalKills, newTotalShots);

    const nextKills = Math.max(Number(prev.kills) || 0, run.kills);
    const nextDist = Math.max(Number(prev.distKm) || 0, run.distKm);

    tx.set(playerRef, {
      kills: nextKills,
      distKm: nextDist,
      gamesPlayed: admin.firestore.FieldValue.increment(1),
      totalKills: admin.firestore.FieldValue.increment(run.kills),
      totalDistKm: admin.firestore.FieldValue.increment(run.distKm),
      lifetimeCoinsCollected: admin.firestore.FieldValue.increment(run.coins),
      totalShots: admin.firestore.FieldValue.increment(run.shots),
      totalIcePickups: admin.firestore.FieldValue.increment(run.icePickups),
      recentRunAts: [...recentRuns, admin.firestore.Timestamp.now()].slice(-LIMITS.maxGamesPerHour),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return { kills: nextKills, distKm: nextDist };
  });

  return { ok: true, ...result };
});

exports.creditBankCoins = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw httpsError('unauthenticated', 'Login required');
  }

  const delta = (data && data.delta) | 0;
  if (delta <= 0 || delta > LIMITS.maxCoinsPerRun) {
    throw httpsError('invalid-argument', 'delta out of range');
  }

  const uid = context.auth.uid;
  const playerRef = db.collection('players').doc(uid);

  const bankCoins = await db.runTransaction(async (tx) => {
    const snap = await tx.get(playerRef);
    if (!snap.exists) {
      throw httpsError('failed-precondition', 'player profile missing');
    }

    const prev = snap.data();
    const nextBank = (Number(prev.bankCoins) || 0) + delta;
    if (nextBank > LIMITS.maxBankCoins) {
      throw httpsError('failed-precondition', 'bank coins limit exceeded');
    }

    tx.set(playerRef, {
      bankCoins: nextBank,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return nextBank;
  });

  return { ok: true, bankCoins };
});

exports.migrateMyBankCoins = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw httpsError('unauthenticated', 'Login required');
  }

  const uid = context.auth.uid;
  const playerRef = db.collection('players').doc(uid);
  const snap = await playerRef.get();
  if (!snap.exists) {
    throw httpsError('failed-precondition', 'player profile missing');
  }

  const prev = snap.data();
  const result = await applyBankCoinsMigration(
    playerRef,
    prev,
    data && data.localBank
  );

  return { ok: true, ...result };
});

exports.adminMigrateBankCoins = functions.https.onRequest(async (req, res) => {
  const configuredSecret = process.env.MIGRATION_SECRET
    || (functions.config().migration && functions.config().migration.secret);
  if (!configuredSecret) {
    res.status(500).json({ ok: false, error: 'MIGRATION_SECRET is not configured' });
    return;
  }

  const providedSecret = req.get('x-migration-secret')
    || (req.query && req.query.secret)
    || '';
  if (providedSecret !== configuredSecret) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return;
  }

  const dryRun = String((req.query && req.query.dryRun) || '').toLowerCase() === '1';
  const stats = {
    scanned: 0,
    migrated: 0,
    skipped: 0,
    dryRun,
  };

  let lastDoc = null;
  const pageSize = 300;

  try {
    while (true) {
      let query = db.collection('players').orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);
      if (lastDoc) query = query.startAfter(lastDoc.id);
      const page = await query.get();
      if (page.empty) break;

      const batch = db.batch();
      let batchWrites = 0;

      for (const doc of page.docs) {
        stats.scanned += 1;
        const prev = doc.data();
        if (hasPersistedBankCoins(prev)) {
          stats.skipped += 1;
          continue;
        }

        const bankCoins = computeMigrationBankCoins(prev, 0);
        stats.migrated += 1;

        if (!dryRun) {
          batch.set(doc.ref, {
            bankCoins,
            bankCoinsMigrated: true,
            bankCoinsMigratedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
          batchWrites += 1;
        }
      }

      if (!dryRun && batchWrites > 0) {
        await batch.commit();
      }

      lastDoc = page.docs[page.docs.length - 1];
      if (page.size < pageSize) break;
    }

    res.json({ ok: true, ...stats });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || 'migration failed',
      ...stats,
    });
  }
});

exports.performRevive = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw httpsError('unauthenticated', 'Login required');
  }

  const bankSpend = (data && data.bankSpend) | 0;
  if (bankSpend < 0 || bankSpend > REVIVE_COST) {
    throw httpsError('invalid-argument', 'bankSpend out of range');
  }

  const uid = context.auth.uid;
  const playerRef = db.collection('players').doc(uid);

  const bankCoins = await db.runTransaction(async (tx) => {
    const snap = await tx.get(playerRef);
    if (!snap.exists) {
      throw httpsError('failed-precondition', 'player profile missing');
    }

    const prev = snap.data();
    const currentBank = Math.max(0, Number(prev.bankCoins) || 0);
    if (bankSpend > currentBank) {
      throw httpsError('failed-precondition', 'not enough bank coins');
    }

    const nextBank = currentBank - bankSpend;
    tx.set(playerRef, {
      bankCoins: nextBank,
      totalRevives: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return nextBank;
  });

  return { ok: true, bankCoins };
});
