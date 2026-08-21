// Package all imports every built-in extension for its registration side
// effect.
//
// One list, imported once by the composition root (cmd/api), so that
// "which extensions does this binary contain?" has a single answer that
// can be read in one screen — rather than being spread across blank
// imports wherever someone happened to need one.
//
// Importing this package registers extensions; it does not enable them.
// An extension only ever runs for a business whose config names it.
package all

import (
	_ "delivery-manager/internal/extensions/everyndays"
)
