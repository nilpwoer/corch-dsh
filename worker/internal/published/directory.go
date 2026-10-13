package published

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// Directory keeps filesystem operations inside an opened root, including symlink resolution.
type Directory struct {
	root     *os.Root
	maxBytes int64
}
type Entry struct {
	Key  string
	Pack Pack
	Hash string
}
type Issue struct {
	Key string
	Err error
}

// OpenDirectory requires an existing directory and an explicit publication size limit.
func OpenDirectory(path string, maxBytes int64) (*Directory, error) {
	if maxBytes < 1 || maxBytes == int64(^uint64(0)>>1) {
		return nil, fmt.Errorf("invalid publication size limit")
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, err
	}
	return &Directory{root: root, maxBytes: maxBytes}, nil
}
func (d *Directory) Close() error { return d.root.Close() }

// Delete removes only the named directory entry; it never follows a symlink target.
func (d *Directory) Delete(key string) error {
	if !ValidKey(key) {
		return fmt.Errorf("invalid publication key")
	}
	return d.root.Remove(key + ".json")
}

// Read returns one complete, validated publication; temporary files and path-shaped keys cannot be read.
func (d *Directory) Read(key string) (Entry, error) {
	if !ValidKey(key) {
		return Entry{}, fmt.Errorf("invalid publication key")
	}
	// Reject directories/devices before opening; manual file tools can leave non-publication entries.
	stat, err := d.root.Stat(key + ".json")
	if err != nil {
		return Entry{}, err
	}
	if !stat.Mode().IsRegular() || stat.Size() > d.maxBytes {
		return Entry{}, fmt.Errorf("invalid publication file or size")
	}
	f, err := d.root.Open(key + ".json")
	if err != nil {
		return Entry{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return Entry{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > d.maxBytes {
		return Entry{}, fmt.Errorf("invalid publication file or size")
	}
	raw, err := io.ReadAll(io.LimitReader(f, d.maxBytes+1))
	if err != nil {
		return Entry{}, err
	}
	if int64(len(raw)) > d.maxBytes {
		return Entry{}, fmt.Errorf("publication too large")
	}
	p, hash, err := Parse(raw)
	return Entry{Key: key, Pack: p, Hash: hash}, err
}

// Scan reports malformed formal files separately; it never selects a default package or exposes a HTTP list.
func (d *Directory) Scan() ([]Entry, []Issue, error) {
	f, err := d.root.Open(".")
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	files, err := f.ReadDir(-1)
	if err != nil {
		return nil, nil, err
	}
	entries := []Entry{}
	issues := []Issue{}
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		key := strings.TrimSuffix(file.Name(), ".json")
		if !ValidKey(key) {
			continue
		}
		entry, err := d.Read(key)
		if err != nil {
			issues = append(issues, Issue{Key: key, Err: err})
			continue
		}
		entries = append(entries, entry)
	}
	return entries, issues, nil
}

// Publish validates before atomically publishing a new immutable file. Existing differing content is never overwritten.
func (d *Directory) Publish(key string, raw []byte) (Entry, error) {
	if !ValidKey(key) || int64(len(raw)) > d.maxBytes {
		return Entry{}, fmt.Errorf("invalid publication key or size")
	}
	p, hash, err := Parse(raw)
	if err != nil {
		return Entry{}, err
	}
	if existing, err := d.Read(key); err == nil {
		if existing.Hash == hash {
			return existing, nil
		}
		return Entry{}, fmt.Errorf("publication key already contains different content")
	} else if !errors.Is(err, os.ErrNotExist) {
		return Entry{}, err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return Entry{}, err
	}
	temp := ".upload-" + hex.EncodeToString(random[:]) + ".tmp"
	f, err := d.root.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return Entry{}, err
	}
	defer d.root.Remove(temp)
	_, writeErr := f.Write(raw)
	if writeErr == nil {
		writeErr = f.Sync()
	}
	closeErr := f.Close()
	if writeErr != nil {
		return Entry{}, writeErr
	}
	if closeErr != nil {
		return Entry{}, closeErr
	}
	// A hard link is an atomic no-replace publication on the same filesystem.
	if err := d.root.Link(temp, key+".json"); err != nil {
		if existing, readErr := d.Read(key); readErr == nil && existing.Hash == hash {
			return existing, nil
		}
		return Entry{}, err
	}
	return Entry{Key: key, Pack: p, Hash: hash}, nil
}
