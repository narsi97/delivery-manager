// Package notify delivers one-time codes to a phone.
//
// The interface is one method wide on purpose. Sending an SMS is a real
// external dependency — an account, credentials, per-message cost, and in
// India a DLT-registered template before a single message is allowed
// through — and that is a decision about the business, not about this
// code. So the product is built against the interface and ships with the
// logging implementation; choosing MSG91 or Twilio later is a new file
// and a config value, not a change to anything that calls this.
//
// Note what is deliberately absent: no retries, no queue, no delivery
// receipts. A code lives five minutes. If the send fails, the honest
// answer is to tell the person to ask for another one, not to keep
// trying in the background against a code that has already expired.
package notify

import (
	"context"
	"log"
)

// Sender delivers a one-time code. Implementations must not log the code
// itself unless they are the development sender below — see LogSender's
// comment for why that one is the exception.
type Sender interface {
	SendOTP(ctx context.Context, phone, code string) error
}

// LogSender writes the code to the server log instead of sending it.
//
// This is what runs until a provider is configured, and it is the reason
// dev and demo work with no account anywhere. It is *not* safe for real
// users: anyone who can read the logs can sign in as anyone. Choosing it
// is therefore loud — see notify.New, which refuses it outside
// development unless explicitly forced.
type LogSender struct{}

func (LogSender) SendOTP(_ context.Context, phone, code string) error {
	log.Printf("[otp] code for %s is %s (no SMS provider configured — see internal/notify)", phone, code)
	return nil
}

// New picks the sender for this environment.
//
// Returning LogSender in production would mean every account is
// accessible to anyone with log access, so it takes an explicit opt-in
// rather than being the silent default. The delivery-manager deployment
// currently runs APP_ENV=dev precisely so this is allowed; moving it to
// prod requires configuring a provider in the same change.
func New(appEnv string, allowLogSenderInProd bool) Sender {
	if appEnv != "prod" || allowLogSenderInProd {
		if appEnv == "prod" {
			log.Printf("[otp] WARNING: running in prod with the logging OTP sender — " +
				"anyone who can read these logs can sign in as any user")
		}
		return LogSender{}
	}
	// No provider is wired yet, so prod without the opt-in has no way to
	// deliver a code. Failing loudly at startup beats a running server
	// where every sign-in silently succeeds at sending nothing.
	log.Printf("[otp] no SMS provider configured for prod; sign-in will fail until one is added " +
		"(set OTP_ALLOW_LOG_SENDER=1 to fall back to logging codes)")
	return unavailableSender{}
}

type unavailableSender struct{}

func (unavailableSender) SendOTP(context.Context, string, string) error {
	return ErrNoProvider
}
