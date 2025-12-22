import { initializeApp, getApps, cert, App } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { getAuth, Auth } from 'firebase-admin/auth';

// Global variables to store instances
let app: App;
let firestore: Firestore;
let authInstance: Auth;

// Initialize Firebase Admin SDK (singleton pattern)
function initializeFirebase() {
  if (!getApps().length) {
    app = initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // The private key needs to have newlines replaced
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  } else {
    app = getApps()[0];
  }

  // Initialize Firestore only once
  if (!firestore) {
    firestore = getFirestore(app);
    // Set Firestore settings for better performance (must be done before any operations)
    firestore.settings({
      ignoreUndefinedProperties: true,
    });
  }

  // Initialize Auth only once
  if (!authInstance) {
    authInstance = getAuth(app);
  }

  return { firestore, authInstance };
}

// Initialize on module load
const { firestore: db, authInstance: auth } = initializeFirebase();

export { db, auth };