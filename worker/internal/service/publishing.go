package service

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/domain"
)

// publisherAuthorization grants only the upload handler and its matching receipt.
// It never creates an administrator session or authorizes management/read routes.
func publisherAuthorization(c config.Portal, backend managementBackend, next http.HandlerFunc) http.HandlerFunc {
	u, _ := url.Parse(c.Origin)
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Host != u.Host || r.Header.Get("Sec-Fetch-Site") == "cross-site" || (r.Header.Get("Origin") != "" && r.Header.Get("Origin") != c.Origin) {
			failure(w, domain.Fail("SAME_ORIGIN_REQUIRED", 403))
			return
		}
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok {
			failure(w, domain.Fail("PUBLISH_AUTH_REQUIRED", 401))
			return
		}
		if err := backend.AuthenticatePublisher(r.Context(), token); err != nil {
			failure(w, err)
			return
		}
		next(w, r)
	}
}
