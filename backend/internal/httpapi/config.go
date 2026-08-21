package httpapi

import (
	"net/http"

	"delivery-manager/internal/domain"
	"delivery-manager/internal/extensions"
)

// Config is readable by any signed-in user, not just admins: a driver's
// app needs the capture specs to know what to ask for at the door, and
// the terminology to avoid calling a student a customer. It contains no
// customer data — only this business's own declarations — so there is
// nothing here a driver shouldn't see.
func (s *Server) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	// available lists what this build can do, so the admin console can
	// offer extensions as labelled toggles rather than making someone
	// type an identifier that fails silently when misspelled.
	available := []map[string]string{}
	for _, extension := range extensions.Available() {
		available = append(available, map[string]string{
			"name":        extension.Name(),
			"description": extension.Description(),
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"config":               sess.Business.Config.WithDefaults(),
		"available_extensions": available,
	})
}

// handleUpdateConfig replaces the whole configuration document. See
// storage.Store.UpdateBusinessConfig for why replacement rather than a
// merge.
//
// The dangerous edit here is removing a field or capture that existing
// records already carry values for. That is allowed — a business must be
// able to stop collecting something — and the historical values stay on
// the records that have them rather than being purged: deleting a
// declaration should not silently destroy months of data that a dispute
// or an invoice might depend on. The values simply stop being displayed
// and stop being accepted on new writes.
func (s *Server) handleUpdateConfig(w http.ResponseWriter, r *http.Request) {
	sess := sessionFrom(r.Context())

	var req struct {
		Config domain.BusinessConfig `json:"config"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	config := req.Config.WithDefaults()
	if err := config.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error(), "invalid_config")
		return
	}

	updated, err := s.store.UpdateBusinessConfig(r.Context(), sess.Business.ID, config)
	if err != nil {
		writeStoreError(w, err, "configuration")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"config": updated.Config, "business": updated})
}

// customFieldsFor validates a submitted custom-field bag against what
// this business declared, writing the error response itself and returning
// ok=false when it doesn't pass. Handlers use it as a guard clause so the
// validation rules live in exactly one place per target.
//
// A nil submission is treated as an empty bag rather than "leave
// unchanged", which matters on the customer PATCH path: sending
// custom_fields explicitly is how a value gets cleared, and the handler
// there only calls this when the key was actually present in the request.
func (s *Server) customFieldsFor(w http.ResponseWriter, sess session, target domain.FieldTarget, submitted domain.FieldValues) (domain.FieldValues, bool) {
	cleaned, err := domain.ValidateFieldValues(sess.Business.Config.CustomFields, target, submitted)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error(), "invalid_custom_fields")
		return nil, false
	}
	return cleaned, true
}
