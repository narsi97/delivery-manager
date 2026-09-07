import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { Banner, Button, Field } from './components';
import { clearSession, loadSession, saveSession } from './session';
import { labelsFor, lower } from './labels';
import { LanguageProvider, useLanguage } from './i18n';
import LanguageSwitcher from './LanguageSwitcher';
import AccountScreen from './screens/AccountScreen';
import BusinessScreen from './screens/BusinessScreen';
import CustomersScreen from './screens/CustomersScreen';
import DriverScreen from './screens/DriverScreen';
import SignInScreen from './screens/SignInScreen';
import TodayScreen from './screens/TodayScreen';
import { colors, radius, spacing } from './theme';

// The column every admin screen lays its cards out in (see each screen's
// `page` style). The header matches it so the two line up.
const CONTENT_WIDTH = 720;

// Tab labels come from the business's own vocabulary, so a school
// operator sees "Students" and "Drivers" rather than a dairy's nouns.
// "Business" has no terminology entry — it's a genuinely new noun outside
// the customer/product/driver vocabulary system, same as "Today" — both
// go through t() instead, since they're app chrome, not business-owned.
//
// There is no Routes tab. Rounds are prepared automatically for every
// service area that has work (see ensureDayRounds), so "create a route"
// was never a job an admin had; a whole tab devoted to it argued
// otherwise, and duplicated most of Today to do it. What was genuinely
// only there — the stops outside every area, and the rare destructive
// actions — moved onto Today, where the day already lives.
// Two, not three. Today and Customers are what a dairy opens every
// morning, and a tab bar should hold what somebody is coming back to —
// not everything the app can do. Products, service routes and drivers
// are set up once and changed rarely, so Business went where the other
// rarely-used screen already lives: behind the avatar, next to Manage
// account, as "Manage business". Rule 3 in Docs/DESIGN.md — rare
// controls are not furniture.
function adminTabs(labels, t) {
  return [
    { key: 'today', label: t('nav_today') },
    { key: 'customers', label: labels.customer_plural },
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
  // driver view of their own route. A one-person dairy is one human doing
  // two jobs, so this is a view toggle rather than a second account.
  const [driving, setDriving] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [accountOpen, setAccountOpen] = useState(false);
  const { t } = useLanguage();

  // The server slides the session forward on use (see api.js). Persist
  // whatever it hands back, so a daily user's token keeps moving and the
  // code screen only reappears after a real absence.
  useEffect(() => {
    api.setTokenRefreshHandler((token) => {
      saveSession({ token });
      setSession((prev) => (prev ? { ...prev, token } : prev));
    });
  }, []);

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

  // The account menu closes on every session change. It is a menu about
  // who is signed in, so leaving it hanging open over a *different*
  // person's screen is the one state it must never be in — and signing
  // out from it left it open across the sign-in screen and into the next
  // session.
  const startSession = useCallback((next) => {
    saveSession({ token: next.token });
    setSession(next);
    setDriving(!next.user?.role?.includes('admin'));
    setTab('today');
    setAccountOpen(false);
  }, []);

  const signOut = useCallback(() => {
    clearSession();
    setSession(null);
    setDriving(false);
    setAccountOpen(false);
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
  // The two screens that left the tab bar for the avatar menu.
  const onSetupScreen = tab === 'business' || tab === 'account';
  const isAdmin = user.role === 'admin' || user.role === 'admin_driver';
  const canDrive = user.role === 'driver' || user.role === 'admin_driver';
  const showDriverView = driving || !isAdmin;

  return (
    <SafeAreaView style={styles.app}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.topBar}>
        <View style={styles.topBarInner}>
          {/* Who you are, not a control. Hanging the menu off the
              business name made the name look like a button and the
              menu hard to find — nobody's instinct is to tap their own
              company to sign out. It is the avatar at the end of the
              row that does that, which is where every other app in this
              suite puts it. */}
          <View style={styles.topBarText}>
            <Text style={styles.businessName} numberOfLines={1}>
              {business.name}
            </Text>
            <Text style={styles.userName} numberOfLines={1}>
              {user.name} · {showDriverView ? lowerRole(labels) : t('role_admin')}
            </Text>
          </View>

          <View style={styles.topBarActions}>
            {!showDriverView
              ? adminTabs(labels, t).map((item) => (
                  <Pressable
                    key={item.key}
                    onPress={() => {
                      setTab(item.key);
                      // Moving to another screen answers whatever the
                      // menu was open for; leaving it hanging over the
                      // new one just pushes the page down.
                      setAccountOpen(false);
                    }}
                    accessibilityRole="button"
                    style={[styles.navTab, tab === item.key && styles.navTabActive]}
                  >
                    <Text style={[styles.navTabText, tab === item.key && styles.navTabTextActive]}>{item.label}</Text>
                  </Pressable>
                ))
              : null}

            <View style={styles.accountAnchor}>
              <Pressable
                onPress={() => setAccountOpen((prev) => !prev)}
                accessibilityRole="button"
                accessibilityLabel={accountOpen ? 'Close account menu' : 'Account menu'}
                accessibilityState={{ expanded: accountOpen }}
                style={[styles.avatar, (accountOpen || onSetupScreen) && styles.avatarOpen]}
              >
                {/* Filled while one of its screens is on the page, so
                    somebody on Manage business can still see where they
                    are — the tab bar no longer says it. */}
                <Text style={[styles.avatarText, (accountOpen || onSetupScreen) && styles.avatarTextOpen]}>
                  {initialOf(user.name)}
                </Text>
              </Pressable>

              {/* Hangs off the avatar rather than pushing the page down.
                  A strip the width of the screen for four short items
                  read as another band of chrome, and it moved whatever
                  the admin was looking at. See Docs/DESIGN.md. */}
              {accountOpen ? (
                <View style={styles.accountMenu}>
                  <View style={styles.accountRow}>
                    <Text style={styles.accountLabel}>{t('language')}</Text>
                    <LanguageSwitcher />
                  </View>

                  {/* A menu is the right shape for "sign out" and the
                      wrong shape for a form with three fields in it, so
                      the password and the business's own details live on
                      a screen and this is the way in. Admins only: a
                      driver has no business details to manage, and their
                      password is on their own account screen. */}
                  {isAdmin && !showDriverView ? (
                    <>
                      {/* The setup screen. Not a tab any more: an owner
                          opens it to add a product or draw a route, and
                          then does not open it again for weeks. */}
                      <Pressable
                        onPress={() => {
                          setTab('business');
                          setAccountOpen(false);
                        }}
                        accessibilityRole="button"
                        style={({ pressed }) => [styles.accountItem, pressed && styles.accountItemPressed]}
                      >
                        <Text style={[styles.accountItemText, tab === 'business' && styles.accountItemCurrent]}>
                          {t('manage_business')}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          setTab('account');
                          setAccountOpen(false);
                        }}
                        accessibilityRole="button"
                        style={({ pressed }) => [styles.accountItem, pressed && styles.accountItemPressed]}
                      >
                        <Text style={[styles.accountItemText, tab === 'account' && styles.accountItemCurrent]}>
                          {t('manage_account')}
                        </Text>
                      </Pressable>
                    </>
                  ) : null}

                  {isAdmin && canDrive ? (
                    <Pressable
                      onPress={() => {
                        setDriving((prev) => !prev);
                        setAccountOpen(false);
                      }}
                      accessibilityRole="button"
                      style={({ pressed }) => [styles.accountItem, pressed && styles.accountItemPressed]}
                    >
                      <Text style={styles.accountItemText}>
                        {showDriverView ? t('switch_to_admin_console') : t('switch_to_driver_mode')}
                      </Text>
                    </Pressable>
                  ) : null}

                  <Pressable
                    onPress={signOut}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.accountItem, styles.accountItemLast, pressed && styles.accountItemPressed]}
                  >
                    <Text style={[styles.accountItemText, styles.signOut]}>{t('sign_out')}</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          </View>
        </View>
      </View>


      {/* Anywhere else closes it. A dropdown that only shuts on its own
          button is one a person leaves open by accident. */}
      {accountOpen ? (
        <Pressable
          style={styles.accountBackdrop}
          onPress={() => setAccountOpen(false)}
          accessibilityLabel="Close account menu"
        />
      ) : null}

      <View style={styles.body}>
        {showDriverView ? (
          <DriverScreen token={token} business={business} />
        ) : tab === 'today' ? (
          <TodayScreen token={token} business={business} />
        ) : tab === 'customers' ? (
          <CustomersScreen token={token} business={business} user={user} />
        ) : tab === 'account' ? (
          <AccountScreen
            token={token}
            business={business}
            user={user}
            onBusinessUpdated={(updated) => setSession((prev) => ({ ...prev, business: updated }))}
            // Arming the delete window has to reach the screens that
            // draw the buttons, not just the page that turned it on.
            onUserUpdated={(updated) => setSession((prev) => ({ ...prev, user: updated }))}
          />
        ) : (
          <BusinessScreen
            token={token}
            business={business}
            user={user}
            currentUserId={user.id}
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

// The first letter of whoever is signed in. Falls back to a dot rather
// than an empty circle, so the target is always visibly there.
function initialOf(name) {
  const first = String(name || '').trim().charAt(0);
  return first ? first.toUpperCase() : '•';
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: colors.background },
  loader: { marginTop: spacing.xl * 2 },
  // flexWrap lets the pill tabs drop to a second line under the business
  // name on a narrow phone instead of overflowing — same technique
  // resume-optimizer's own header row uses for the same reason.
  // The bar itself spans the window so its surface and bottom rule reach
  // both edges; its *contents* are held to the same column the screens
  // use, so the tabs line up over the cards instead of being flung to the
  // far edge of a wide monitor with a lake of empty space between them
  // and the business name. Same shape as resume-optimizer, whose header
  // simply lives inside its content container.
  topBar: {
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    // The account menu hangs out of this bar, and React Native Web gives
    // every View position:relative — so without a z-index here the bar
    // is just an earlier sibling of the page, and the page paints over
    // the menu.
    zIndex: 50,
  },
  // The horizontal padding lives here rather than on the bar, so the
  // account and the tabs line up with the *edges of the cards* below
  // them — each screen pads inside its own column the same way. Padding
  // the bar instead would leave the header sitting a notch wider than
  // everything it sits above, which is more obviously wrong than being
  // centred slightly off.
  topBarInner: {
    width: '100%',
    maxWidth: CONTENT_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  account: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    marginLeft: -spacing.sm,
    borderRadius: radius.md,
    flexShrink: 1,
  },
  accountOpen: { backgroundColor: colors.surfaceAlt },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.xs,
  },
  avatarOpen: { backgroundColor: colors.accent, borderColor: colors.accent },
  avatarText: { fontSize: 14, fontWeight: '700', color: colors.accent },
  avatarTextOpen: { color: colors.accentText },
  accountChevron: { fontSize: 11, color: colors.subtitle, flexShrink: 0 },
  // Anchored to the avatar. zIndex so it sits over the page rather than
  // between the bar and it; the backdrop below catches the click that
  // closes it.
  accountAnchor: { position: 'relative', zIndex: 30 },
  accountMenu: {
    position: 'absolute',
    top: 44,
    right: 0,
    minWidth: 220,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.xs,
    // A menu floats, so it is the one place in this app that casts a
    // shadow — that is what says it is over the page and not part of it.
    shadowColor: '#0f172a',
    shadowOpacity: 0.16,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  accountBackdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 20 },
  // Inside a menu now, so the rows are menu rows: padded to the menu's
  // own edge, divided from each other rather than boxed.
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    flexWrap: 'wrap',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  accountLabel: { fontSize: 13, fontWeight: '600', color: colors.label },
  // Which of the two setup screens is on the page behind the menu —
  // they left the tab bar, so this is the only thing still saying it.
  accountItemCurrent: { color: colors.accent, fontWeight: '700' },
  accountItem: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    minHeight: 44,
    justifyContent: 'center',
  },
  accountItemLast: {},
  accountItemPressed: { backgroundColor: colors.surfaceAlt },
  accountItemText: { fontSize: 15, fontWeight: '600', color: colors.link },
  topBarText: { paddingRight: spacing.xs, flexShrink: 1 },
  businessName: { fontSize: 16, fontWeight: '800', color: colors.text },
  userName: { fontSize: 12, color: colors.subtitle, marginTop: 1 },
  // flexShrink + maxWidth is what makes the wrap below actually trigger.
  // React Native's default flexShrink is 0 (unlike web CSS's 1), so
  // without this a flex item sizes itself to fit its content no matter
  // how little room its parent actually has — this row would rather
  // push "Sign out" off the edge of the screen than shrink to the width
  // that would make its own flexWrap kick in.
  topBarActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
    flexShrink: 1,
    maxWidth: '100%',
  },
  // Pill tabs — same shape as resume-optimizer's navTab: a bordered pill
  // that fills with the accent colour when active, so the section you're
  // on reads as one glance rather than needing a separate "you are here"
  // line the way the burger-menu subtitle used to carry.
  navTab: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  navTabActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  navTabText: { color: colors.label, fontSize: 13, fontWeight: '600' },
  navTabTextActive: { color: colors.accentText },
  signOut: { fontSize: 14, fontWeight: '600', color: colors.link },
  body: { flex: 1 },
});
