import React, { createContext, useContext, useState } from 'react';

import { loadLanguage, saveLanguage } from './language';

// Scope, deliberately: this dictionary translates the app's own static
// chrome — button labels, headings, hints, status words. It never
// touches business-authored content (customer names, addresses, notes,
// a business's own custom-field labels, or its chosen terminology like
// "Student" instead of "Customer" — see labels.js). Someone typed that
// in whatever language they typed it in, and silently retranslating it
// would be actively wrong, not helpful.
//
// Coverage in this pass: the sign-in screen (both admin and driver
// halves — a driver should be able to switch language before they've
// even signed in) and the driver's whole app (the actual point of the
// feature — drivers are the least technical audience), plus top-level
// App.js chrome. The admin console body screens (Customers, Today,
// Drivers, Business) still read English literals directly; they can
// move onto this same t() mechanism incrementally later.
export const LANGUAGES = [
  { value: 'en', label: 'EN' },
  { value: 'te', label: 'తె' },
];

const STRINGS = {
  en: {
    app_title: 'Delivery Manager',
    app_subtitle: 'Recurring deliveries, optimized rounds, one app.',
    tab_business_admin: 'Business admin',
    tab_driver: 'Driver',
    sign_in: 'Sign in',
    create_business: 'Create a business',
    business_name_label: 'Business name',
    what_do_you_deliver: 'What do you deliver?',
    business_type_dairy: 'Dairy / milk',
    business_type_school: 'School transport',
    business_type_grocery: 'Grocery',
    business_type_water: 'Water',
    business_type_other: 'Other',
    timezone_label: 'Timezone',
    timezone_hint: "Delivery days roll over on this clock, not your phone's.",
    google_not_configured:
      "Google Sign-In isn't configured on this server. Set EXPO_PUBLIC_GOOGLE_CLIENT_ID (frontend) and GOOGLE_CLIENT_ID (backend) to enable admin accounts.",
    continue_as_dev_admin: 'Continue as local dev admin',
    signup_required_error: 'No business is registered to that Google account yet. Switch to "Create a business" below.',
    phone_number_label: 'Phone number',
    pin_label: 'PIN',
    pin_placeholder_digits: '6 digits',
    start_my_round: 'Start my round',
    pin_hint: 'Your PIN comes from whoever manages your deliveries. Ask them to reset it if you forget.',
    sign_out: 'Sign out',
    role_admin: 'admin',
    switch_to_admin_console: 'Switch to admin console',
    switch_to_driver_mode: 'Switch to driver mode',
    language: 'Language',
    nav_today: 'Today',
    nav_business: 'Business',
    no_route_assigned: 'No {route} assigned to you yet. Check back once your manager has planned the day.',
    stops_label: 'Stops',
    done_label: 'Done',
    left_label: 'Left',
    next_stop_heading: 'NEXT STOP',
    navigate: 'Navigate',
    delivered_action: 'Delivered',
    couldnt_deliver: "Couldn't deliver",
    add_note: 'Add a note',
    confirm: 'Confirm',
    back: 'Back',
    before_marking_delivered: 'Before marking delivered',
    before_reporting_problem: 'Before reporting a problem',
    note_optional: 'Note (optional)',
    status_pending: 'pending',
    status_delivered: 'delivered',
    status_failed: 'failed',
    status_skipped: 'skipped',
  },
  te: {
    app_title: 'డెలివరీ మేనేజర్',
    app_subtitle: 'క్రమం తప్పకుండా డెలివరీలు, ఆప్టిమైజ్డ్ రౌండ్లు, ఒకే యాప్.',
    tab_business_admin: 'వ్యాపార అడ్మిన్',
    tab_driver: 'డ్రైవర్',
    sign_in: 'సైన్ ఇన్',
    create_business: 'కొత్త వ్యాపారాన్ని నమోదు చేయండి',
    business_name_label: 'వ్యాపార పేరు',
    what_do_you_deliver: 'మీరు ఏమి డెలివరీ చేస్తారు?',
    business_type_dairy: 'పాల వ్యాపారం',
    business_type_school: 'పాఠశాల రవాణా',
    business_type_grocery: 'కిరాణా సరుకులు',
    business_type_water: 'నీరు',
    business_type_other: 'ఇతరం',
    timezone_label: 'కాల మండలం',
    timezone_hint: 'డెలివరీ రోజులు మీ ఫోన్ గడియారం ప్రకారం కాకుండా, ఈ గడియారం ప్రకారం మారతాయి.',
    google_not_configured:
      'ఈ సర్వర్‌లో Google సైన్-ఇన్ కాన్ఫిగర్ చేయలేదు. అడ్మిన్ ఖాతాలను ప్రారంభించడానికి EXPO_PUBLIC_GOOGLE_CLIENT_ID (ఫ్రంటెండ్) మరియు GOOGLE_CLIENT_ID (బ్యాకెండ్) సెట్ చేయండి.',
    continue_as_dev_admin: 'లోకల్ డెవ్ అడ్మిన్‌గా కొనసాగండి',
    signup_required_error: 'ఆ Google ఖాతాకు ఇంకా ఏ వ్యాపారం నమోదు కాలేదు. క్రింద "కొత్త వ్యాపారాన్ని నమోదు చేయండి"కి మారండి.',
    phone_number_label: 'ఫోన్ నంబర్',
    pin_label: 'పిన్',
    pin_placeholder_digits: '6 అంకెలు',
    start_my_round: 'నా రౌండ్ ప్రారంభించండి',
    pin_hint: 'మీ పిన్ మీ డెలివరీలను నిర్వహించే వ్యక్తి నుండి వస్తుంది. మర్చిపోతే, దాన్ని రీసెట్ చేయమని వారిని అడగండి.',
    sign_out: 'సైన్ అవుట్',
    role_admin: 'అడ్మిన్',
    switch_to_admin_console: 'అడ్మిన్ కన్సోల్‌కు మారండి',
    switch_to_driver_mode: 'డ్రైవర్ మోడ్‌కు మారండి',
    language: 'భాష',
    nav_today: 'ఈరోజు',
    nav_business: 'వ్యాపారం',
    no_route_assigned: 'మీకు ఇంకా {route} కేటాయించలేదు. మీ మేనేజర్ రోజును ప్లాన్ చేసిన తర్వాత మళ్లీ చూడండి.',
    stops_label: 'స్టాప్‌లు',
    done_label: 'పూర్తయింది',
    left_label: 'మిగిలినవి',
    next_stop_heading: 'తదుపరి స్టాప్',
    navigate: 'నావిగేట్ చేయండి',
    delivered_action: 'డెలివరీ అయింది',
    couldnt_deliver: 'డెలివరీ చేయలేకపోయాను',
    add_note: 'గమనిక జోడించండి',
    confirm: 'నిర్ధారించండి',
    back: 'వెనుకకు',
    before_marking_delivered: 'డెలివరీ అయిందని గుర్తించే ముందు',
    before_reporting_problem: 'సమస్యను నివేదించే ముందు',
    note_optional: 'గమనిక (ఐచ్ఛికం)',
    status_pending: 'పెండింగ్‌లో',
    status_delivered: 'డెలివరీ అయింది',
    status_failed: 'విఫలమైంది',
    status_skipped: 'దాటవేయబడింది',
  },
};

// {placeholder} substitution — used for the couple of strings that embed
// a business-terminology word ("No {route} assigned..."), so the
// sentence translates while the business's own vocabulary stays exactly
// what they set it to.
function format(template, vars) {
  if (!vars) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? vars[key] : match));
}

const LanguageContext = createContext({
  lang: 'en',
  t: (key) => STRINGS.en[key] || key,
  setLanguage: () => {},
});

export function LanguageProvider({ children }) {
  const [lang, setLang] = useState(loadLanguage);

  const setLanguage = (next) => {
    setLang(next);
    saveLanguage(next);
  };

  // Falls back to English, then to the raw key, so a missing translation
  // degrades to readable (if wrong-language) text instead of a blank
  // label — the same "never a blank screen" principle session.js uses
  // for a corrupt localStorage entry.
  const t = (key, vars) => format(STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key, vars);

  return <LanguageContext.Provider value={{ lang, t, setLanguage }}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  return useContext(LanguageContext);
}
