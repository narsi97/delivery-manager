import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import * as api from './api';
import { Banner, Button, Field, ViewToggle } from './components';
import { clearSession, loadSession, saveSession } from './session';
import { labelsFor, lower } from './labels';
import { HeaderInsetContext } from './layout';
import { LanguageProvider, useLanguage } from './i18n';
import LanguageSwitcher from './LanguageSwitcher';
import AccountScreen from './screens/AccountScreen';
import BusinessScreen from './screens/BusinessScreen';
import CustomersScreen from './screens/CustomersScreen';
import DriverScreen from './screens/DriverScreen';
import HerdScreen from './screens/HerdScreen';
import MilkingScreen from './screens/MilkingScreen';
import SignInScreen from './screens/SignInScreen';
import TodayScreen from './screens/TodayScreen';
import { colors, radius, spacing } from './theme';

// The column every admin screen lays its cards out in (see each screen's
// `page` style). The header matches it so the two line up.
const CONTENT_WIDTH = 720;

// Two tabs, each holding the day's work and the register behind it.
//
// The app grew a second book. Deliveries answers "what goes out"; the
// herd answers "what comes in, and from which animal" — and each has the
// same two halves: a date-bound sheet somebody fills in every day, and a
// register they open when something changes. So the split is by domain,
// not by screen, and the sub-navigation is the same shape on both sides —
// learning one teaches the other.
//
// Customers is the delivery side's register, and it was the weakest tab
// in the bar by the only test a tab has to pass: it is opened when a
// customer signs up or pauses, not every morning. Milk is entered twice
// a day, which is what earned the herd its place instead.
//
// Labels come from the business's own vocabulary where there is one, so
// a school operator sees "Students". The rest go through t(): they are
// app chrome, not business-owned nouns.
//
// Two things deliberately absent. There is no Routes tab — rounds are
// prepared automatically for every service area that has work (see
// ensureDayRounds), so "create a route" was never a job an admin had,
// and a tab devoted to it duplicated most of Today to argue otherwise.
// And Business is not here either: products, service routes and drivers
// are set up once and changed rarely, so it lives behind the avatar next
// to Manage account. Rule 3 in Docs/DESIGN.md — rare controls are not
// furniture.
function adminTabs(labels, t, business) {
  const tabs = [
    {
      key: 'deliveries',
      label: t('nav_deliveries'),
      // ViewToggle keys on `value`, not `key` — see components.js.
      views: [
        { value: 'today', label: t('nav_today') },
        { value: 'customers', label: labels.customer_plural },
      ],
    },
  ];
  // Only for a business that keeps animals. A school bus operator has no
  // herd, and a tab for one is furniture (Docs/DESIGN.md, rule 3) —
  // gated on the config rather than the business type, so a goat farmer
  // who signed up as "other" can turn it on. See domain.BusinessConfig.
  if (business?.config?.herd) {
    tabs.push({
      key: 'cattle',
      label: t('nav_cattle'),
      views: [
        { value: 'milking', label: t('nav_milking') },
        { value: 'herd', label: t('nav_herd') },
      ],
    });
  }
  return tabs;
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
  const [tab, setTab] = useState('deliveries');
  // Which half of the open tab is showing. Kept per tab rather than as
  // one value, so stepping over to the herd and back lands on the
  // delivery screen you left rather than resetting to the day board.
  const [views, setViews] = useState({ deliveries: 'today', cattle: 'milking' });
  // 'driving' lets an owner who is both admin and driver switch to the
  // driver view of their own route. A one-person dairy is one human doing
  // two jobs, so this is a view toggle rather than a second account.
  const [driving, setDriving] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [accountOpen, setAccountOpen] = useState(false);
  const { t } = useLanguage();

  // The header gets out of the way.
  //
  // A phone screen is about eight hundred points tall and this header
  // was spending a sixth of that on a business name that does not change
  // and two tabs somebody touches twice a session — while the thing they
  // actually came to read, a round of forty stops or a shed of forty
  // animals, got what was left. So scrolling down slides the identity
  // row away and leaves the Milking/Herd switch pinned at the top, and
  // any scroll back up brings the whole thing straight back.
  //
  // Back on *any* upward scroll, not only at the top of the list: the
  // reason to want the header mid-list is to leave, and making somebody
  // scroll two hundred rows back to the top to find the way out is the
  // version of this that people hate.
  const headerTranslate = useRef(new Animated.Value(0)).current;
  const headerHidden = useRef(false);
  const lastScrollY = useRef(0);
  const identityHeight = useRef(0);
  const [headerHeight, setHeaderHeight] = useState(0);

  const setHeaderShown = useCallback(
    (shown) => {
      if (headerHidden.current === !shown) {
        return;
      }
      headerHidden.current = !shown;
      Animated.timing(headerTranslate, {
        toValue: shown ? 0 : -identityHeight.current,
        duration: 180,
        // Web has no native animation thread; RNW writes the transform
        // straight to the node either way, without a React re-render.
        useNativeDriver: false,
      }).start();
    },
    [headerTranslate]
  );

  const onBodyScroll = useCallback(
    (event) => {
      const y = event.nativeEvent.contentOffset.y;
      const dy = y - lastScrollY.current;
      lastScrollY.current = y;
      // Small movements are a thumb resting, not a decision — and iOS
      // rubber-banding past the top reports negative offsets that would
      // otherwise read as "scrolling up" forever.
      if (Math.abs(dy) < 6) {
        return;
      }
      setHeaderShown(dy < 0 || y <= identityHeight.current);
    },
    [setHeaderShown]
  );

  // Every new screen starts with the header showing. Arriving somewhere
  // with the way out already hidden is disorienting, and the scroll
  // position resets anyway.
  useEffect(() => {
    lastScrollY.current = 0;
    headerHidden.current = false;
    headerTranslate.setValue(0);
  }, [tab, views, headerTranslate]);

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
    setTab('deliveries');
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
  const tabs = adminTabs(labels, t, business);
  const activeTab = tabs.find((item) => item.key === tab);

  const subNav = activeTab?.views ? (
    <SubNav
      value={views[tab]}
      onChange={(next) => setViews((prev) => ({ ...prev, [tab]: next }))}
      options={activeTab.views}
    />
  ) : null;
  // The two screens that left the tab bar for the avatar menu.
  const onSetupScreen = tab === 'business' || tab === 'account';
  const isAdmin = user.role === 'admin' || user.role === 'admin_driver';
  const canDrive = user.role === 'driver' || user.role === 'admin_driver';
  const showDriverView = driving || !isAdmin;

  return (
    <SafeAreaView style={styles.app}>
      <StatusBar barStyle="dark-content" />

      {/* The header floats over the page instead of sitting above it, so
          it can slide away without leaving a hole where it was. What it
          covers is handed to every screen through HeaderInsetContext,
          which usePageStyle turns into the page's own top padding. */}
      <Animated.View
        style={[styles.header, { transform: [{ translateY: headerTranslate }] }]}
        onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
      >
        <View
          style={styles.topBar}
          // Only the identity row slides away; the sub-nav below it is
          // what stays pinned, so this is exactly how far to travel.
          onLayout={(event) => {
            identityHeight.current = event.nativeEvent.layout.height;
          }}
        >
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
              ? tabs.map((item) => (
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

        {/* Stays put while the identity row above it slides away, so the
            switch between a tab's two halves is reachable all the way
            down a long list. */}
        {!showDriverView ? subNav : null}
      </Animated.View>

      {/* Anywhere else closes it. A dropdown that only shuts on its own
          button is one a person leaves open by accident. */}
      {accountOpen ? (
        <Pressable
          style={styles.accountBackdrop}
          onPress={() => setAccountOpen(false)}
          accessibilityLabel="Close account menu"
        />
      ) : null}

      <HeaderInsetContext.Provider value={headerHeight}>
      <View style={styles.body}>
        {showDriverView ? (
          <DriverScreen token={token} business={business} />
        ) : tab === 'deliveries' ? (
          views.deliveries === 'customers' ? (
            <CustomersScreen token={token} business={business} user={user} onScroll={onBodyScroll} />
          ) : (
            <TodayScreen token={token} business={business} onScroll={onBodyScroll} />
          )
        ) : tab === 'cattle' ? (
          views.cattle === 'herd' ? (
            <HerdScreen token={token} user={user} onScroll={onBodyScroll} />
          ) : (
            <MilkingScreen token={token} onScroll={onBodyScroll} />
          )
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
      </HeaderInsetContext.Provider>
    </SafeAreaView>
  );
}

// The sub-nav, built to be pinned.
//
// Two things it needs that an ordinary row does not. It must be opaque,
// because once it sticks the table runs underneath it and a transparent
// strip would show rows sliding through the words. And it must own the
// full width of the content column rather than hugging its pills, or the
// rows would slide past in the gap beside them.
//
// The hairline is the only ink spent on saying "content continues below
// this". It stays put whether pinned or not: a rule that appears on
// scroll is a second thing moving on a screen where the table is already
// moving.
function SubNav({ value, onChange, options }) {
  return (
    <View style={styles.subNav}>
      <ViewToggle value={value} onChange={onChange} options={options} />
    </View>
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
  // The whole floating header: identity row plus sub-nav. Absolute so
  // that sliding it up leaves no gap behind it, and above the page so
  // the list passes underneath rather than through it.
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 50,
  },
  subNav: {
    flexDirection: 'row',
    alignItems: 'center',
    // Opaque and full width: once the identity row is gone this is what
    // the list runs underneath, and a transparent strip would show rows
    // sliding through the words.
    backgroundColor: colors.background,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  body: { flex: 1 },
});
