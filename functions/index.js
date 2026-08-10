const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");

admin.initializeApp();

const app = express();
const db = admin.firestore();

app.use(cors({ origin: true }));
app.use(express.json());

// Public liveness checks — no auth, no user data. Mirrors this project's
// other public health endpoint (healthCheck in the main functions codebase).
app.get("/test", (req, res) => {
  res.send("API is working");
});

app.get("/integration/health", async (req, res) => {
  // firebaseReady: a real Firestore round-trip against the same healthPing/probe
  // doc the main app's healthCheck function writes (NFR-002). A successful get()
  // proves connectivity even if the doc hasn't been written yet.
  let firebaseReady = false;
  try {
    await db.collection("healthPing").doc("probe").get();
    firebaseReady = true;
  } catch (err) {
    console.error("integration/health: Firestore connectivity check failed", err.message);
  }

  // sharePointConnected / webhooksHealthy: registerSharePointWebhooks and
  // renewSharePointWebhooks (main app) write one doc per active Graph webhook
  // subscription to sharepointSubscriptions, keyed by expirationDateTime.
  // Connected means at least one subscription hasn't expired; healthy means
  // none have expired without the daily renewal cron catching them.
  let sharePointConnected = false;
  let webhooksHealthy = true;
  try {
    const nowIso = new Date().toISOString();
    const subsSnap = await db.collection("sharepointSubscriptions").get();
    sharePointConnected = subsSnap.docs.some((doc) => doc.data().expirationDateTime > nowIso);
    webhooksHealthy = !subsSnap.docs.some((doc) => doc.data().expirationDateTime <= nowIso);
  } catch (err) {
    console.error("integration/health: sharepointSubscriptions check failed", err.message);
    webhooksHealthy = false;
  }

  res.json({
    documentStorageMode: "Firebase",
    sharePointConnected,
    firebaseReady,
    webhooksHealthy,
  });
});

// Every route below requires a valid Firebase ID token. There is no
// unauthenticated fallback — callers without one are rejected here, before
// reaching any Firestore data.
app.use(async (req, res, next) => {
  const authorization = req.header("authorization") || "";
  const match = authorization.match(/^Bearer (.+)$/i);
  if (!match) {
    res.status(401).json({ error: "Firebase ID token is required." });
    return;
  }

  try {
    req.auth = await admin.auth().verifyIdToken(match[1]);
  } catch (error) {
    console.warn("Rejecting invalid Firebase ID token", error.message);
    res.status(401).json({ error: "Invalid or expired Firebase ID token." });
    return;
  }

  next();
});

function titleCase(value) {
  if (!value || typeof value !== "string") {
    return "";
  }

  return value
    .replace(/_/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function normalizeRole(role) {
  if (!role || typeof role !== "string") {
    return "Student";
  }

  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
}

function mapUserProfile(doc) {
  const data = doc.data();
  return {
    id: data.id || doc.id,
    displayName: data.displayName || data.email || "EduAssist User",
    email: data.email || "",
    role: normalizeRole(data.role),
    onboardingComplete: Boolean(data.onboardingComplete),
  };
}

async function createMissingUserProfile(uid, email, requestedRole) {
  const role = normalizeRole(requestedRole || "Teacher");
  const displayName = email ? email.split("@")[0] : "EduAssist User";
  const profile = {
    id: uid,
    email: email || "",
    displayName,
    role: role.toLowerCase(),
    onboardingComplete: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    privacyConsentGiven: false,
  };

  await db.collection("users").doc(uid).set(profile, { merge: true });

  return {
    id: uid,
    displayName,
    email: email || "",
    role,
    onboardingComplete: true,
  };
}

function mapLearningProfile(doc, studentId) {
  const data = doc.data();
  return {
    studentId: data.studentId || data.id || studentId || doc.id,
    grade: data.grade ? `${data.grade}` : "",
    learningStyle: titleCase(data.learningStyle) || "Not set",
    interests: Array.isArray(data.interests) ? data.interests : [],
  };
}

function mapContentItem(doc, progressByContentId) {
  const data = doc.data();
  const progress = progressByContentId.get(data.id || doc.id);
  return {
    id: data.id || doc.id,
    title: data.title || "Untitled content",
    type: titleCase(data.contentType || data.type) || "Content",
    completed: progress?.status === "completed" || progress?.completionPercent >= 100,
  };
}

async function fetchContentItemsById(ids, progressByContentId) {
  if (!ids.length) {
    return [];
  }

  const docs = [];
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const snap = await db.collection("contentItems").where("id", "in", chunk).get();
    docs.push(...snap.docs);
  }

  const byId = new Map(docs.map((doc) => [doc.data().id || doc.id, doc]));
  return ids.map((id) => {
    const doc = byId.get(id);
    if (!doc) {
      return {
        id,
        title: id,
        type: "Content",
        completed: progressByContentId.get(id)?.status === "completed",
      };
    }

    return mapContentItem(doc, progressByContentId);
  });
}

async function fetchProgressByContentId(studentId) {
  const snap = await db.collection("studentProgress").where("studentId", "==", studentId).get();
  return new Map(snap.docs.map((doc) => {
    const data = doc.data();
    return [data.contentItemId, data];
  }));
}

async function mapLearningPath(doc, progressByContentId) {
  const data = doc.data();
  const pathItems = Array.isArray(data.items) ? data.items : [];
  const sortedPathItems = pathItems
    .filter((item) => item && item.contentItemId)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const contentIds = sortedPathItems.map((item) => item.contentItemId);
  const items = await fetchContentItemsById(contentIds, progressByContentId);
  const completedCount = items.filter((item) => item.completed).length;

  return {
    id: data.id || doc.id,
    title: data.title || "Untitled path",
    subject: items[0]?.subject || data.subject || "Learning",
    progress: items.length ? completedCount / items.length : 0,
    items,
  };
}

function mapCompanionMessage(doc) {
  const data = doc.data();
  const role = data.role === "assistant" ? "Companion" : titleCase(data.role) || data.author || "Student";
  const createdAt = data.createdAt?.toDate ? data.createdAt.toDate() : new Date();

  return {
    author: role,
    text: data.text || "",
    createdAt: createdAt.toISOString(),
  };
}

// A caller may view a student's data if they ARE that student, hold a
// confirmed studentAdultLinks link to them, or are an admin. Mirrors the
// same linkId convention ("{adultId}_{studentId}") used by assignLessonPlan
// in the main app's functions/index.js.
async function canAccessStudent(callerUid, studentId) {
  if (callerUid === studentId) {
    return true;
  }

  const [callerDoc, linkDoc] = await Promise.all([
    db.collection("users").doc(callerUid).get(),
    db.collection("studentAdultLinks").doc(`${callerUid}_${studentId}`).get(),
  ]);

  if (callerDoc.exists && callerDoc.data().role === "admin") {
    return true;
  }

  const link = linkDoc.data();
  return Boolean(linkDoc.exists && link?.confirmed === true);
}

app.get("/me/link-summary", async (req, res) => {
  try {
    const uid = req.auth.uid;
    const [profileDoc, adultLinksSnap, studentLinksSnap] = await Promise.all([
      db.collection("users").doc(uid).get(),
      db.collection("studentAdultLinks").where("adultId", "==", uid).get(),
      db.collection("studentAdultLinks").where("studentId", "==", uid).get(),
    ]);

    const adultLinks = adultLinksSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const studentLinks = studentLinksSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    res.json({
      uid,
      email: req.auth.email || "",
      profileExists: profileDoc.exists,
      profile: profileDoc.exists ? mapUserProfile(profileDoc) : null,
      adultLinkCount: adultLinks.length,
      confirmedAdultLinkCount: adultLinks.filter((link) => link.confirmed === true).length,
      studentLinkCount: studentLinks.length,
      confirmedStudentLinkCount: studentLinks.filter((link) => link.confirmed === true).length,
      adultLinks: adultLinks.map((link) => ({
        id: link.id,
        studentId: link.studentId || "",
        adultRole: link.adultRole || "",
        confirmed: Boolean(link.confirmed),
        studentEmail: link.studentEmail || "",
      })),
      studentLinks: studentLinks.map((link) => ({
        id: link.id,
        adultId: link.adultId || "",
        adultRole: link.adultRole || "",
        confirmed: Boolean(link.confirmed),
        studentEmail: link.studentEmail || "",
      })),
    });
  } catch (error) {
    console.error("link-summary route failed", error);
    res.status(500).json({ error: "Unable to load link summary." });
  }
});

app.get("/profile", async (req, res) => {
  try {
    const uid = req.auth.uid;
    const email = req.auth.email || "";
    const role = typeof req.query.role === "string" ? req.query.role : "";

    const doc = await db.collection("users").doc(uid).get();
    if (doc.exists) {
      res.json(mapUserProfile(doc));
      return;
    }

    const createdProfile = await createMissingUserProfile(uid, email, role);
    res.json(createdProfile);
  } catch (error) {
    console.error("profile route failed", error);
    res.status(500).json({ error: "Unable to load profile." });
  }
});

app.get("/learning-profile/:studentId", async (req, res) => {
  try {
    const { studentId } = req.params;
    if (!(await canAccessStudent(req.auth.uid, studentId))) {
      res.status(403).json({ error: "Not authorized to view this student." });
      return;
    }

    const snap = await db.collection("learningProfiles").doc(studentId).get();
    if (!snap.exists) {
      res.status(404).json({ error: "Learning profile not found." });
      return;
    }

    res.json(mapLearningProfile(snap, studentId));
  } catch (error) {
    console.error("learning-profile route failed", error);
    res.status(500).json({ error: "Unable to load learning profile." });
  }
});

app.get("/learning-paths", async (req, res) => {
  try {
    const studentId = req.auth.uid;
    const progressByContentId = await fetchProgressByContentId(studentId);
    const snap = await db.collection("learningPaths")
      .where("studentId", "==", studentId)
      .where("isActive", "==", true)
      .get();

    const paths = await Promise.all(snap.docs.map((doc) => mapLearningPath(doc, progressByContentId)));
    res.json(paths);
  } catch (error) {
    console.error("learning-paths route failed", error);
    res.status(500).json({ error: "Unable to load learning paths." });
  }
});

app.get("/linked-students", async (req, res) => {
  try {
    const adultId = req.auth.uid;
    const linksSnap = await db.collection("studentAdultLinks")
      .where("adultId", "==", adultId)
      .where("confirmed", "==", true)
      .get();

    const students = await Promise.all(linksSnap.docs.map(async (linkDoc) => {
      const link = linkDoc.data();
      const studentId = link.studentId;
      const [studentDoc, learningProfileDoc, progressByContentId] = await Promise.all([
        db.collection("users").doc(studentId).get(),
        db.collection("learningProfiles").doc(studentId).get(),
        fetchProgressByContentId(studentId),
      ]);
      const profile = studentDoc.exists ? mapUserProfile(studentDoc) : null;
      const learningProfile = learningProfileDoc.exists ? mapLearningProfile(learningProfileDoc, studentId) : null;
      const completed = Array.from(progressByContentId.values()).filter((progress) => progress.status === "completed").length;
      const total = Math.max(progressByContentId.size, 1);

      return {
        id: studentId,
        displayName: profile?.displayName || link.studentEmail || studentId,
        grade: learningProfile?.grade || "",
        progress: progressByContentId.size ? completed / total : 0,
        alertSummary: "On track",
      };
    }));

    res.json(students);
  } catch (error) {
    console.error("linked-students route failed", error);
    res.status(500).json({ error: "Unable to load linked students." });
  }
});

app.get("/companion/messages", async (req, res) => {
  try {
    const studentId = req.auth.uid;
    const snap = await db.collection("conversations")
      .doc(studentId)
      .collection("messages")
      .orderBy("createdAt", "asc")
      .limit(40)
      .get();

    res.json(snap.docs.map(mapCompanionMessage));
  } catch (error) {
    console.error("companion messages route failed", error);
    res.status(500).json({ error: "Unable to load companion messages." });
  }
});

app.post("/companion/messages", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "Message text is required." });
    return;
  }

  const studentId = req.auth.uid;
  const companionReplyText = "I can help with that. The next integration step is routing this through askCompanion with Firebase Auth.";

  try {
    const conversation = db.collection("conversations").doc(studentId).collection("messages");
    const batch = db.batch();
    const userRef = conversation.doc();
    const replyRef = conversation.doc();
    batch.set(userRef, {
      role: "user",
      text,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    batch.set(replyRef, {
      role: "assistant",
      text: companionReplyText,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await batch.commit();

    res.status(201).json({
      messages: [
        { author: "Student", text, createdAt: new Date().toISOString() },
        { author: "Companion", text: companionReplyText, createdAt: new Date().toISOString() },
      ],
    });
  } catch (error) {
    console.error("companion send persistence failed", error);
    res.status(500).json({ error: "Unable to send message." });
  }
});

exports.desktopApi = onRequest(app);
