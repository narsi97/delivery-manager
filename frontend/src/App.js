import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, ActivityIndicator, Modal, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native';

const DRAWER_WIDTH = 260;

import * as api from './api';
import { clearSession, loadSession, saveSession } from './session';
import { labelsFor, lower } from './labels';
import { LanguageProvider, useLanguage } from './i18n';
import LanguageSwitcher from './LanguageSwitcher';
import BusinessScreen from './screens/BusinessScreen';
import CustomersScreen from './screens/CustomersScreen';
import DriverScreen from './screens/DriverScreen';
import DriversScreen from './screens/DriversScreen';
import RoutesScreen from './screens/RoutesScreen';
import SignInScreen from './screens/SignInScreen';
import TodayScreen from './screens/TodayScreen';
import { colors, spacing } from './theme';

// Tab labels come from the business's own vocabulary, so a school
// operator sees "Students" and "Drivers" rather than a dairy's nouns.
// "Business" has no terminology entry — it's a genuinely new noun outside
// the customer/product/driver vocabulary system, same as "Today" — both
// go through t() instead, since they're app chrome, not business-owned.
function adminTabs(labels, t) {
  return [
    { key: 'today', label: t('nav_today') },
    { key: 'routes', label: `${labels.route}s` },
    { key: 'customers', label: labels.customer_plural },
    { key: 'team', label: labels.driver + 's' },
    { key: 'business', label: t('nav_business') },
  ];
}

// LanguageProvider wraps the whole app so useLanguage() is available
// from the sign-in screen (a driver should be able to switch language
// before they've even signed in) all the way through the driver app.
export default function App() {
  return (
    <LanguageProvider>
      <AppShell />
    </LanguageProvider>
  );
}

function AppShell() {
  const [session, setSession] = useState(null);
  const [tab, setTab] = useState('today');
  // 'driving' lets an owner who is both admin and driver switch to the
  // driver view of their own round. A one-person dairy is one human doing
  // two jobs, so this is a view toggle rather than a second account.
  const [driving, setDriving] = useState(false);
  const [restoring, setRestoring] = useState(true);
  // Section nav lives in a burger menu, not a tab row — Today is glanced
  // at constantly through a shift, Customers and Drivers are setup screens
  // visited far less often, so they don't need to compete for width on
  // every screen the way three permanent tabs would.
  const [menuOpen, setMenuOpen] = useState(false);
  const { t } = useLanguage();

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
        {!showDriverView ? (
          <Pressable
            onPress={() => setMenuOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={t('open_menu')}
            style={styles.burger}
          >
            <View style={styles.burgerLine} />
            <View style={styles.burgerLine} />
            <View style={styles.burgerLine} />
          </Pressable>
        ) : null}
        <View style={styles.topBarText}>
          <Text style={styles.businessName} numberOfLines={1}>
            {business.name}
          </Text>
          <Text style={styles.userName} numberOfLines={1}>
            {user.name} · {showDriverView ? lowerRole(labels) : t('role_admin')}
            {showDriverView ? '' : ` · ${currentSectionLabel(labels, tab, t)}`}
          </Text>
        </View>
        <View style={styles.topBarActions}>
          <LanguageSwitcher />
          <Pressable onPress={signOut} accessibilityRole="button">
            <Text style={styles.signOut}>{t('sign_out')}</Text>
          </Pressable>
        </View>
      </View>

      {isAdmin && canDrive ? (
        <Pressable onPress={() => setDriving((prev) => !prev)} style={styles.roleToggle}>
          <Text style={styles.roleToggleText}>
            {showDriverView ? t('switch_to_admin_console') : t('switch_to_my_route', { route: lower(labels.route) })}
          </Text>
        </Pressable>
      ) : null}

      <NavMenu
        visible={menuOpen && !showDriverView}
        onClose={() => setMenuOpen(false)}
        activeTab={tab}
        onSelect={(key) => {
          setTab(key);
          setMenuOpen(false);
        }}
        labels={labels}
        t={t}
      />

      <View style={styles.body}>
        {showDriverView ? (
          <DriverScreen token={token} business={business} />
        ) : tab === 'today' ? (
          <TodayScreen token={token} business={business} />
        ) : tab === 'routes' ? (
          <RoutesScreen token={token} business={business} />
        ) : tab === 'customers' ? (
          <CustomersScreen token={token} business={business} />
        ) : tab === 'team' ? (
          <DriversScreen token={token} business={business} currentUserId={user.id} />
        ) : (
          <BusinessScreen
            token={token}
            business={business}
            onBusinessUpdated={(updated) => setSession((prev) => ({ ...prev, business: updated }))}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

function lowerRole(labels) {
  return lower(labels.driver);
}

function currentSectionLabel(labels, tab, t) {
  return adminTabs(labels, t).find((item) => item.key === tab)?.label || '';
}

// Slide-in drawer from the left, behind a tap-anywhere-to-close backdrop.
// A real RN Modal rather than an absolutely-positioned sibling View — it
// renders outside the normal layout tree, which sidesteps the
// position:'fixed'-inside-a-scrolling-ancestor bug the other 3VNSYSTEMS
// apps have hit before (see resume-optimizer's WebPortal.web.js) without
// needing a portal component of our own.
//
// The slide itself is a manual Animated.timing on translateX rather than
// Modal's own animationType — Modal's built-in "slide" animates the
// whole overlay (backdrop included) as one block, and its direction is
// mobile-platform-specific (bottom-associated), not the left-edge drawer
// this needs. Driving translateX directly also means the drawer can stay
// mounted for its own ~200ms close animation instead of being yanked out
// the instant `visible` flips — Modal unmounts its children immediately
// otherwise, which is why `mounted` is tracked separately from `visible`.
function NavMenu({ visible, onClose, activeTab, onSelect, labels, t }) {
  const [mounted, setMounted] = useState(visible);
  const translateX = useRef(new Animated.Value(visible ? 0 : -DRAWER_WIDTH)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(translateX, { toValue: 0, duration: 220, useNativeDriver: false }).start();
    } else if (mounted) {
      Animated.timing(translateX, { toValue: -DRAWER_WIDTH, duration: 180, useNativeDriver: false }).start(() => {
        setMounted(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!mounted) {
    return null;
  }

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('close_menu')} />
      <Animated.View style={[styles.drawer, { transform: [{ translateX }] }]}>
        <Text style={styles.drawerTitle}>{t('menu_heading')}</Text>
        {adminTabs(labels, t).map((item) => (
          <Pressable
            key={item.key}
            onPress={() => onSelect(item.key)}
            style={[styles.drawerItem, activeTab === item.key && styles.drawerItemActive]}
            accessibilityRole="button"
          >
            <Text style={[styles.drawerItemText, activeTab === item.key && styles.drawerItemTextActive]}>
              {item.label}
            </Text>
          </Pressable>
        ))}
      </Animated.View>
    </Modal>
  );
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
  burger: { padding: spacing.xs, marginRight: spacing.md, gap: 4 },
  burgerLine: { width: 20, height: 2, borderRadius: 1, backgroundColor: colors.text },
  topBarText: { flex: 1, paddingRight: spacing.md },
  businessName: { fontSize: 16, fontWeight: '800', color: colors.text },
  userName: { fontSize: 12, color: colors.subtitle, marginTop: 1 },
  topBarActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  signOut: { fontSize: 14, fontWeight: '600', color: colors.link },
  roleToggle: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surfaceAlt,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  roleToggleText: { fontSize: 13, fontWeight: '600', color: colors.link },
  body: { flex: 1 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(15, 23, 42, 0.4)' },
  drawer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: DRAWER_WIDTH,
    maxWidth: '80%',
    backgroundColor: colors.surface,
    paddingTop: spacing.xl,
    paddingHorizontal: spacing.md,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 2, height: 0 },
    elevation: 8,
  },
  drawerTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.hint,
    textTransform: 'uppercase',
    letterSpacing: 0.06,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  drawerItem: { paddingVertical: spacing.md, paddingHorizontal: spacing.sm, borderRadius: 8 },
  drawerItemActive: { backgroundColor: colors.surfaceAlt },
  drawerItemText: { fontSize: 16, fontWeight: '600', color: colors.label },
  drawerItemTextActive: { color: colors.accent },
});
