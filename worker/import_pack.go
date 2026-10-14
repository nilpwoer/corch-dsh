package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/fanzy531/corch-dsh/worker/internal/published"
	"github.com/spf13/cobra"
)

// newImportPackCommand uses OS directory permissions, not an HTTP administrator session.
// It never loads service configuration, connects to a database, or starts a listener.
func newImportPackCommand() *cobra.Command {
	var file, directory, key string
	var maxBytes int64
	var dryRun, requireInvitation bool
	c := &cobra.Command{Use: "import-pack", Short: "Validate and atomically import one DSH publication locally", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !published.ValidKey(key) || maxBytes < 1 || maxBytes == int64(^uint64(0)>>1) {
				return fmt.Errorf("invalid publication key or size limit")
			}
			info, err := os.Lstat(file)
			if err != nil || !info.Mode().IsRegular() || info.Size() > maxBytes {
				return fmt.Errorf("input must be a regular file within the explicit size limit")
			}
			f, err := os.Open(file)
			if err != nil {
				return err
			}
			raw, readErr := io.ReadAll(io.LimitReader(f, maxBytes+1))
			closeErr := f.Close()
			if readErr != nil {
				return readErr
			}
			if closeErr != nil {
				return closeErr
			}
			if int64(len(raw)) > maxBytes {
				return fmt.Errorf("publication too large")
			}
			pack, hash, err := published.Parse(raw)
			if err != nil {
				return err
			}
			if _, err := (published.Entry{Key: key, Pack: pack, Hash: hash}).Snapshot("import-validation"); err != nil {
				return err
			}
			if requireInvitation && (pack.Invitation == nil || pack.Invitation.Status != "active" || pack.Invitation.Code == "") {
				return fmt.Errorf("an active invitation is required")
			}
			d, err := published.OpenDirectory(directory, maxBytes)
			if err != nil {
				return err
			}
			defer d.Close()
			existing, err := d.Read(key)
			alreadyPresent := err == nil
			if alreadyPresent && existing.Hash != hash {
				return fmt.Errorf("publication key already contains different content")
			}
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			if !dryRun {
				if _, err := d.Publish(key, raw); err != nil {
					return err
				}
			}
			// Never print invitation codes or their brute-forceable whole-publication digest.
			return json.NewEncoder(cmd.OutOrStdout()).Encode(struct {
				Key            string `json:"key"`
				FieldnoteID    string `json:"fieldnoteId"`
				Version        int64  `json:"version"`
				Questions      int    `json:"questions"`
				DryRun         bool   `json:"dry_run"`
				AlreadyPresent bool   `json:"already_present"`
			}{key, pack.FieldnoteID, pack.Meta.Version, len(pack.Questions), dryRun, alreadyPresent})
		}}
	c.Flags().StringVar(&file, "file", "", "DSH publication JSON file")
	c.Flags().StringVar(&directory, "packs-dir", "", "Existing authorized publication directory")
	c.Flags().StringVar(&key, "key", "", "Unique URL-safe immutable publication key")
	c.Flags().Int64Var(&maxBytes, "max-bytes", 0, "Explicit deployment publication size limit")
	c.Flags().BoolVar(&dryRun, "dry-run", false, "Validate without writing files")
	c.Flags().BoolVar(&requireInvitation, "require-invitation", false, "Require an active invitation for code-protected deployments")
	for _, flag := range []string{"file", "packs-dir", "key", "max-bytes"} {
		_ = c.MarkFlagRequired(flag)
	}
	return c
}
