package notify

import "errors"

// ErrNoProvider is returned when a code cannot be delivered because no
// SMS provider is configured. Surfaced to the caller as a plain "we
// couldn't send the code" rather than the reason, which is an operator's
// problem and not something to explain on a sign-in screen.
var ErrNoProvider = errors.New("no SMS provider configured")
