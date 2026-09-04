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
    app_subtitle: 'Recurring deliveries, optimized routes, one app.',
    sign_in: 'Sign in',
    phone_number: 'Phone number',
    password: 'Password',
    signin_password_hint: 'Your number and the password your dairy gave you. Ask them if you have forgotten it.',
    change_password: 'Change password',
    current_password: 'Current password',
    new_password: 'New password',
    confirm_password: 'Type it again',
    passwords_do_not_match: "Those two don't match."
    ,
    manage_account: 'Manage account',
    nav_account: 'Account',
    password_changed: 'Password changed.',
    send_me_a_code: 'Send me a code',
    the_code: 'The code',
    code_sent: 'Code sent.',
    code_sent_to: 'We sent a 6-digit code to {phone}. It lasts 5 minutes.',
    use_a_different_number: 'Use a different number',
    no_account_yet: "That number is new here, so let's set your business up.",
    business_name: 'Business name',
    your_name: 'Your name',
    kind_of_business: 'What kind of business?',
    business_type_dairy: 'Dairy',
    signin_hint: 'New here? Put your number in and we\'ll set you up.',
    business_type_dairy: 'Dairy / milk',
    business_type_school: 'School transport',
    business_type_grocery: 'Grocery',
    business_type_water: 'Water',
    business_type_other: 'Other',
    continue_as_dev_admin: 'Continue as local dev admin',
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
    navigate: '🧭 Navigate',
    call_customer: '📞 Call',
    delivered_action: 'Delivered',
    couldnt_deliver: "Couldn't deliver",
    add_note: 'Add a note',
    confirm: 'Confirm',
    back: 'Back',
    before_marking_delivered: 'Before marking delivered',
    before_reporting_problem: 'Before reporting a problem',
    note_optional: 'Note (optional)',
    // Loading up at the farm, before the round opens. This is the one
    // screen a driver meets before they have any stops to look at, so it
    // is translated like the rest of their day rather than left in
    // English on the assumption that a number is self-explanatory.
    checkin_heading_loading: 'At the farm',
    checkin_heading_waiting: 'Waiting to be checked',
    checkin_heading_rejected: 'Count again',
    checkin_lead_loading: 'Count what you are loading and send it. Your stops open once it is approved.',
    checkin_lead_waiting: 'You reported {units}. {route} opens as soon as it is approved.',
    checkin_lead_rejected: 'The count did not match. Count again and resend.',
    checkin_units_label: 'How many?',
    checkin_units_placeholder: '40',
    checkin_note_label: 'Anything to add? (optional)',
    checkin_note_placeholder: '2 crates short',
    checkin_send: 'Send to the office',
    checkin_resend: 'Send the new count',
    checkin_your_round: 'Your round',
    checkin_stops_locked: 'Your stops appear here once your load is approved.',
    status_pending: 'pending',
    status_delivered: 'delivered',
    status_failed: 'failed',
    status_skipped: 'skipped',
  },
  te: {
    app_title: 'డెలివరీ మేనేజర్',
    app_subtitle: 'క్రమం తప్పకుండా డెలివరీలు, ఆప్టిమైజ్డ్ రూట్లు, ఒకే యాప్.',
    sign_in: 'సైన్ ఇన్',
    phone_number: 'ఫోన్ నంబర్',
    password: 'పాస్‌వర్డ్',
    signin_password_hint: 'మీ నంబర్ మరియు మీ డెయిరీ ఇచ్చిన పాస్‌వర్డ్. మర్చిపోతే వారిని అడగండి.',
    change_password: 'పాస్‌వర్డ్ మార్చండి',
    current_password: 'ప్రస్తుత పాస్‌వర్డ్',
    new_password: 'కొత్త పాస్‌వర్డ్',
    confirm_password: 'మళ్ళీ టైప్ చేయండి',
    passwords_do_not_match: 'ఆ రెండూ సరిపోలడం లేదు.'
    ,
    manage_account: 'ఖాతా నిర్వహణ',
    nav_account: 'ఖాతా',
    password_changed: 'పాస్‌వర్డ్ మార్చబడింది.',
    send_me_a_code: 'కోడ్ పంపండి',
    the_code: 'కోడ్',
    code_sent: 'కోడ్ పంపబడింది.',
    code_sent_to: '{phone}కు 6 అంకెల కోడ్ పంపాము. ఇది 5 నిమిషాలు చెల్లుతుంది.',
    use_a_different_number: 'వేరే నంబర్ వాడండి',
    no_account_yet: 'ఈ నంబర్ ఇక్కడ కొత్తది — మీ వ్యాపారాన్ని నమోదు చేద్దాం.',
    business_name: 'వ్యాపారం పేరు',
    your_name: 'మీ పేరు',
    kind_of_business: 'ఏ రకమైన వ్యాపారం?',
    business_type_dairy: 'డెయిరీ',
    signin_hint: 'కొత్తవారా? మీ నంబర్ ఇవ్వండి, మేము నమోదు చేస్తాం.',
    business_type_dairy: 'పాల వ్యాపారం',
    business_type_school: 'పాఠశాల రవాణా',
    business_type_grocery: 'కిరాణా సరుకులు',
    business_type_water: 'నీరు',
    business_type_other: 'ఇతరం',
    continue_as_dev_admin: 'లోకల్ డెవ్ అడ్మిన్‌గా కొనసాగండి',
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
    navigate: '🧭 నావిగేట్ చేయండి',
    call_customer: '📞 కాల్ చేయండి',
    delivered_action: 'డెలివరీ అయింది',
    couldnt_deliver: 'డెలివరీ చేయలేకపోయాను',
    add_note: 'గమనిక జోడించండి',
    confirm: 'నిర్ధారించండి',
    back: 'వెనుకకు',
    before_marking_delivered: 'డెలివరీ అయిందని గుర్తించే ముందు',
    before_reporting_problem: 'సమస్యను నివేదించే ముందు',
    note_optional: 'గమనిక (ఐచ్ఛికం)',
    checkin_heading_loading: 'ఫారం దగ్గర',
    checkin_heading_waiting: 'తనిఖీ కోసం ఎదురుచూస్తోంది',
    checkin_heading_rejected: 'మళ్ళీ లెక్కించండి',
    checkin_lead_loading: 'మీరు లోడ్ చేస్తున్నది లెక్కించి పంపండి. ఆమోదం వచ్చాక మీ స్టాప్‌లు కనిపిస్తాయి.',
    checkin_lead_waiting: 'మీరు {units} తెలిపారు. ఆమోదం వచ్చిన వెంటనే {route} తెరుచుకుంటుంది.',
    checkin_lead_rejected: 'లెక్క సరిపోలలేదు. మళ్ళీ లెక్కించి పంపండి.',
    checkin_units_label: 'ఎన్ని?',
    checkin_units_placeholder: '40',
    checkin_note_label: 'ఏమైనా చెప్పాలా? (ఐచ్ఛికం)',
    checkin_note_placeholder: '2 క్రేట్లు తక్కువ',
    checkin_send: 'ఆఫీసుకు పంపండి',
    checkin_resend: 'కొత్త లెక్క పంపండి',
    checkin_your_round: 'మీ రౌండ్',
    checkin_stops_locked: 'మీ లోడ్ ఆమోదం పొందిన తర్వాత మీ స్టాప్‌లు ఇక్కడ కనిపిస్తాయి.',
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
