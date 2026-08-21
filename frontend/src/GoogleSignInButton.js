import React, { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { getFrontendConfig } from './config/environments';

// "Sign in with Google" — web only, and only when
// EXPO_PUBLIC_GOOGLE_CLIENT_ID is set (see config/environments.js);
// renders nothing otherwise. Same pattern as Interest Optimizer's and
// Resume Optimizer's GoogleSignInButton: load Google Identity Services
// once, then mount its button into a plain DOM node, since
// react-native-web View refs aren't reliably the raw DOM node GIS needs
// to render into.
//
// Only admins ever see this. Drivers sign in with a phone number and PIN
// their admin issued — see api.driverSignIn.
export default function GoogleSignInButton({ onCredential }) {
  const containerRef = useRef(null);
  const onCredentialRef = useRef(onCredential);
  onCredentialRef.current = onCredential;
  const { googleClientId } = getFrontendConfig();

  useEffect(() => {
    if (Platform.OS !== 'web' || !googleClientId || typeof document === 'undefined') return undefined;

    let cancelled = false;
    const renderButton = () => {
      if (cancelled || !containerRef.current || !window.google?.accounts?.id) return;
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: (response) => onCredentialRef.current(response.credential),
      });
      containerRef.current.innerHTML = '';
      window.google.accounts.id.renderButton(containerRef.current, {
        theme: 'outline',
        size: 'large',
        width: 280,
      });
    };

    if (window.google?.accounts?.id) {
      renderButton();
      return () => {
        cancelled = true;
      };
    }

    let script = document.getElementById('google-identity-services');
    if (!script) {
      script = document.createElement('script');
      script.id = 'google-identity-services';
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener('load', renderButton);
    return () => {
      cancelled = true;
      script.removeEventListener('load', renderButton);
    };
  }, [googleClientId]);

  if (Platform.OS !== 'web' || !googleClientId) return null;
  return React.createElement('div', { ref: containerRef, style: { minHeight: 40 } });
}
