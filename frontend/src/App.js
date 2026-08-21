import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { clearSession, loadSession, saveSession } from './session';
import { labelsFor, lower } from './labels';
import CustomersScreen from './screens/CustomersScreen';
import DriverScreen from './screens/DriverScreen';
import DriversScreen from './screens/DriversScreen';
import SignInScreen from './screens/SignInScreen';
import TodayScreen from './screens/TodayScreen';
import { colors, spacing } from './theme';

// Tab labels come from the business's own vocabulary, so a school
// operator sees "Students" and "Drivers" rather than a dairy's nouns.
function adminTabs(labels) {
  return [
    { key: 'today', label: 'Today' },
    { key: 'customers', label: labels.customer_plural },
    { key: 'team', label: labels.driver + 's' },
  ];
}

export default function App() {
  const [session, setSession] = useState(null);
  const [tab, setTab] = useState('today');
  // 'driving' lets an owner who is both admin and driver switch to the
  // driver view of their own round. A one-person dairy is one human doing
  // two jobs, so this is a view toggle rather than a second account.
  const [driving, setDriving] = useState(false);
  const [restoring, setRestoring] = useState(true);

  // Restore a stored token on load, but only after the server confirms it
  // is still good — a token whose account has since been deactivated must
  // not produce a UI that looks signed in and fails on every action.
  useEffect(() => {
    const stored = loadSession();
    if (!stored?.token) {
      setRestoring(false);
      return;
    }

    let cancelled = false;
    api
      .getMe(stored.token)
      .then((fresh) => {
        if (!cancelled) {
          setSession({ ...fresh, token: stored.token });
        }
      })
      .catch(() => {
        if (!cancelled) {
          clearSession();
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRestoring(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const startSession = useCallback((next) => {
    saveSession({ token: next.token });
    setSession(next);
    setDriving(!next.user?.role?.includes('admin'));
    setTab('today');
  }, []);

  const signOut = useCallback(() => {
    clearSession();
    setSession(null);
    setDriving(false);
  }, []);

  if (restoring) {
    return (
      <SafeAreaView style={styles.app}>
        <ActivityIndicator style={styles.loader} color={colors.accent} />
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.app}>
        <StatusBar barStyle="dark-content" />
        <SignInScreen onSession={startSession} />
      </SafeAreaView>
    );
  }

  const { user, business, token } = session;
  const labels = labelsFor(business);
  const isAdmin = user.role === 'admin' || user.role === 'admin_driver';
  const canDrive = user.role === 'driver' || user.role === 'admin_driver';
  const showDriverView = driving || !isAdmin;

  return (
    <SafeAreaView style={styles.app}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.topBar}>
        <View style={styles.topBarText}>
          <Text style={styles.businessName} numberOfLines={1}>
            {business.name}
          </Text>
          <Text style={styles.userName} numberOfLines={1}>
            {user.name} · {showDriverView ? lowerRole(labels) : 'admin'}
          </Text>
        </View>
        <Pressable onPress={signOut} accessibilityRole="button">
          <Text style={styles.signOut}>Sign out</Text>
        </Pressable>
      </View>

      {isAdmin && canDrive ? (
        <Pressable onPress={() => setDriving((prev) => !prev)} style={styles.roleToggle}>
          <Text style={styles.roleToggleText}>
            {showDriverView ? 'Switch to admin console' : `Switch to my ${lower(labels.route)}`}
          </Text>
        </Pressable>
      ) : null}

      {showDriverView ? null : (
        <View style={styles.tabs}>
          {adminTabs(labels).map((item) => (
            <Pressable
              key={item.key}
              onPress={() => setTab(item.key)}
              style={[styles.tab, tab === item.key && styles.tabActive]}
              accessibilityRole="tab"
            >
              <Text style={[styles.tabText, tab === item.key && styles.tabTextActive]}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <View style={styles.body}>
        {showDriverView ? (
          <DriverScreen token={token} business={business} />
        ) : tab === 'today' ? (
          <TodayScreen token={token} business={business} />
        ) : tab === 'customers' ? (
          <CustomersScreen token={token} business={business} />
        ) : (
          <DriversScreen token={token} business={business} currentUserId={user.id} />
        )}
      </View>
    </SafeAreaView>
  );
}

function lowerRole(labels) {
  return lower(labels.driver);
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: colors.background },
  loader: { marginTop: spacing.xl * 2 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  topBarText: { flex: 1, paddingRight: spacing.md },
  businessName: { fontSize: 16, fontWeight: '800', color: colors.text },
  userName: { fontSize: 12, color: colors.subtitle, marginTop: 1 },
  signOut: { fontSize: 14, fontWeight: '600', color: colors.link },
  roleToggle: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surfaceAlt,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  roleToggleText: { fontSize: 13, fontWeight: '600', color: colors.link },
  tabs: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tab: { flex: 1, paddingVertical: spacing.md, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: colors.accent },
  tabText: { fontSize: 14, fontWeight: '600', color: colors.subtitle },
  tabTextActive: { color: colors.accent },
  body: { flex: 1 },
});
