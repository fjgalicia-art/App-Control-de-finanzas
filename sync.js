// Sincronización con la nube: inicio de sesión con Google y gastos guardados en Firestore.
//
// Estructura en Firestore (las reglas solo permiten a cada usuario leer/escribir lo suyo):
//   users/{uid}                    → { settings: { rate, cards }, updatedAt }
//   users/{uid}/expenses/{gastoId} → un gasto
//
// La configuración de abajo no es secreta: identifica el proyecto de Firebase y
// está hecha para ir en el código de la app. La seguridad la dan las reglas.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, getDoc, getDocs, onSnapshot, setDoc, deleteDoc, writeBatch, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBmF-cDgTwdI-F8dmYKnSsWNMZ70D09WhY',
  authDomain: 'mis-gastos-f3098.firebaseapp.com',
  projectId: 'mis-gastos-f3098',
  storageBucket: 'mis-gastos-f3098.firebasestorage.app',
  messagingSenderId: '884732712049',
  appId: '1:884732712049:web:31b14561bfdaf590aa77d0',
};

// Cuenta cuyos datos ya están en este teléfono (para no volver a mezclar al abrir la app).
const OWNER_KEY = 'mis-gastos.owner';

const App = window.App;
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Caché local persistente: funciona sin internet y sube los cambios al reconectar.
const fs = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

let uid = null;
let unsubscribers = [];

const userRef = () => doc(fs, 'users', uid);
const expensesRef = () => collection(fs, 'users', uid, 'expenses');
const expenseRef = id => doc(fs, 'users', uid, 'expenses', id);

const remoteSettings = s => ({ rate: s.rate, cards: s.cards });

/** Firestore no acepta `undefined`; guarda solo los campos conocidos. */
function cleanExpense(e) {
  return {
    id: e.id,
    amount: e.amount,
    currency: e.currency === 'USD' ? 'USD' : 'GTQ',
    rate: e.rate ?? null,
    desc: e.desc,
    card: e.card,
    date: e.date,
    createdAt: e.createdAt ?? Date.now(),
  };
}

function report(err) {
  console.error(err);
  App.setSyncStatus(navigator.onLine ? 'error' : 'offline');
}

/** Ejecuta escrituras en lotes (Firestore permite hasta 500 por lote). */
async function commit(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(fs);
    ops.slice(i, i + 400).forEach(op => op(batch));
    await batch.commit();
  }
}

/* ---------- Escrituras desde la app ---------- */

function putExpense(e) {
  if (!uid || !e) return;
  setDoc(expenseRef(e.id), cleanExpense(e)).catch(report);
}

function removeExpense(id) {
  if (!uid) return;
  deleteDoc(expenseRef(id)).catch(report);
}

function putSettings() {
  if (!uid) return;
  setDoc(userRef(), { settings: remoteSettings(App.db.settings), updatedAt: serverTimestamp() }, { merge: true })
    .catch(report);
}

/** Tras restaurar un respaldo: la nube queda igual que este teléfono. */
async function replaceAll() {
  if (!uid) return;
  try {
    const local = App.db;
    const localIds = new Set(local.expenses.map(e => e.id));
    const remote = await getDocs(expensesRef());
    const ops = [b => b.set(userRef(), { settings: remoteSettings(local.settings), updatedAt: serverTimestamp() })];
    remote.docs.filter(d => !localIds.has(d.id)).forEach(d => ops.push(b => b.delete(d.ref)));
    local.expenses.forEach(e => ops.push(b => b.set(expenseRef(e.id), cleanExpense(e))));
    await commit(ops);
  } catch (err) {
    report(err);
  }
}

/* ---------- Sesión ---------- */

async function signIn() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
      return signInWithRedirect(auth, provider);
    }
    if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
      console.error(err);
      App.toast('No se pudo iniciar sesión. Intenta de nuevo.');
    }
  }
}

async function doSignOut() {
  const ok = confirm('Tus gastos quedan guardados en tu cuenta de Google. ' +
    'En este teléfono se ocultarán hasta que vuelvas a iniciar sesión. ¿Cerrar sesión?');
  if (!ok) return;
  await signOut(auth);
  localStorage.removeItem(OWNER_KEY);
  App.resetLocal();
  App.toast('Sesión cerrada');
}

/**
 * Primera vez de esta cuenta en este teléfono: sube lo que ya había aquí sin
 * borrar nada de la nube (si la cuenta es nueva, sube todo).
 */
async function firstSync() {
  if (localStorage.getItem(OWNER_KEY) === uid) return;

  const local = App.db;
  const [userSnap, remote] = await Promise.all([getDoc(userRef()), getDocs(expensesRef())]);
  const remoteIds = new Set(remote.docs.map(d => d.id));
  const toUpload = local.expenses.filter(e => !remoteIds.has(e.id));
  const ops = [];

  let settings = userSnap.exists() ? userSnap.data().settings : null;
  if (!settings) {
    settings = remoteSettings(local.settings);
    ops.push(b => b.set(userRef(), { settings, updatedAt: serverTimestamp() }, { merge: true }));
  } else {
    // Si se suben gastos de una tarjeta que la cuenta no tiene, agrega esa tarjeta.
    const missing = local.settings.cards.filter(c =>
      toUpload.some(e => e.card === c.id) && !(settings.cards || []).some(r => r.id === c.id));
    if (missing.length) {
      const cards = [...(settings.cards || []), ...missing];
      ops.push(b => b.set(userRef(), { settings: { ...settings, cards }, updatedAt: serverTimestamp() }, { merge: true }));
    }
  }
  toUpload.forEach(e => ops.push(b => b.set(expenseRef(e.id), cleanExpense(e))));

  await commit(ops);
  localStorage.setItem(OWNER_KEY, uid);
}

/** Sube los cambios hechos mientras no había sesión activa. */
function flushPending() {
  for (const op of App.takePending()) {
    if (op.type === 'put') putExpense(App.db.expenses.find(e => e.id === op.id));
    else if (op.type === 'remove') removeExpense(op.id);
    else if (op.type === 'settings') putSettings();
    else if (op.type === 'all') replaceAll();
  }
}

function listen() {
  unsubscribers.push(onSnapshot(userRef(), snap => {
    const settings = snap.exists() ? snap.data().settings : null;
    if (settings) App.applyRemote({ settings });
  }, report));

  let first = true;
  unsubscribers.push(onSnapshot(expensesRef(), { includeMetadataChanges: true }, snap => {
    if (first || snap.docChanges().length) {
      first = false;
      App.applyRemote({ expenses: snap.docs.map(d => d.data()) });
    }
    const { hasPendingWrites, fromCache } = snap.metadata;
    App.setSyncStatus(hasPendingWrites ? (navigator.onLine ? 'pending' : 'offline') : fromCache && !navigator.onLine ? 'offline' : 'ok');
  }, report));
}

let retryTimer = null;

/** Conecta la cuenta: primero sube lo local y solo después escucha la nube. */
async function start(user) {
  try {
    await firstSync();
  } catch (err) {
    // Sin esto, la nube (aún vacía o incompleta) podría reemplazar gastos que solo están aquí.
    report(err);
    retryTimer = setTimeout(() => uid === user.uid && start(user), 15000);
    return;
  }
  flushPending();
  App.setActive(true);
  listen();
}

onAuthStateChanged(auth, user => {
  clearTimeout(retryTimer);
  unsubscribers.forEach(unsub => unsub());
  unsubscribers = [];
  App.setActive(false);
  uid = user ? user.uid : null;

  if (!user) {
    App.setAccount(null);
    return;
  }

  App.setAccount({ name: user.displayName, email: user.email, photo: user.photoURL, status: 'syncing' });
  start(user);
});

window.addEventListener('offline', () => uid && App.setSyncStatus('offline'));

App.setCloud({
  signIn,
  signOut: doSignOut,
  put: putExpense,
  remove: removeExpense,
  putSettings,
  replaceAll,
});
