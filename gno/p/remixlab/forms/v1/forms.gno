// Package forms is the Remix Lab forms block: a fixed field schema, typed
// and bounded answers, sequential submission IDs and a small review status
// (submitted, accepted, rejected).
//
// All answers are public chain data. Recipes should only ask for information
// that is meant to be published.
//
// The schema can change only while the form has no submissions; after that
// a host must create a new Form. A *Form belongs in an unexported host-realm
// variable, and the host authenticates submitters and reviewers.
package forms

import (
	"strconv"

	"gno.land/p/nt/avl/v0"
	"gno.land/p/remixlab/core/v1"
)

// Hard bounds that no configuration may exceed.
const (
	HardMaxFields      = 10
	HardMaxSubmissions = 1000
	HardMaxFieldBytes  = 2048
	HardMaxPayload     = 8192
	HardMaxChoices     = 20
)

// FieldKind is the type of answer a field accepts.
type FieldKind int

const (
	KindText FieldKind = iota
	KindInteger
	KindChoice
)

func (k FieldKind) String() string {
	switch k {
	case KindText:
		return "text"
	case KindInteger:
		return "integer"
	case KindChoice:
		return "choice"
	}
	return "unknown"
}

// Field describes one form field.
type Field struct {
	Name      string // identifier, e.g. "title"
	Label     string
	Kind      FieldKind
	Required  bool
	MaxBytes  int      // text only
	Multiline bool     // text only
	Min, Max  int64    // integer only, inclusive
	Choices   []string // choice only
}

// Config bounds the form.
type Config struct {
	MaxSubmissions  int
	MaxPerSubmitter int // 0 means unlimited (still bounded by MaxSubmissions)
	MaxPayloadBytes int // sum of answer bytes
}

func (c Config) validate() error {
	switch {
	case c.MaxSubmissions < 1 || c.MaxSubmissions > HardMaxSubmissions:
		return core.Errorf(core.ErrInvalidInput, "maxSubmissions out of range")
	case c.MaxPerSubmitter < 0:
		return core.Errorf(core.ErrInvalidInput, "maxPerSubmitter out of range")
	case c.MaxPayloadBytes < 1 || c.MaxPayloadBytes > HardMaxPayload:
		return core.Errorf(core.ErrInvalidInput, "maxPayloadBytes out of range")
	}
	return nil
}

type submission struct {
	id        uint64
	submitter address
	answers   []string
	status    core.SubmissionStatus
}

// Form holds a schema and its submissions.
type Form struct {
	cfg          Config
	fields       []Field
	subs         *avl.Tree // zero-padded id -> *submission
	perSubmitter *avl.Tree // address -> int
	byStatus     [3]int
	nextID       uint64
}

// New creates a form. It panics on an invalid schema or configuration,
// since hosts call it from init with generated constants.
func New(cfg Config, fields []Field) *Form {
	if err := cfg.validate(); err != nil {
		panic(err.Error())
	}
	f := &Form{cfg: cfg, subs: avl.NewTree(), perSubmitter: avl.NewTree()}
	if err := f.setFields(fields); err != nil {
		panic(err.Error())
	}
	return f
}

// SetFields replaces the schema. It fails once any submission exists.
func (f *Form) SetFields(fields []Field) error {
	if f.subs.Size() > 0 {
		return core.Errorf(core.ErrInvalidState, "schema is frozen once submissions exist")
	}
	return f.setFields(fields)
}

func (f *Form) setFields(fields []Field) error {
	if len(fields) == 0 || len(fields) > HardMaxFields {
		return core.Errorf(core.ErrInvalidInput, "field count out of range")
	}
	names := map[string]bool{}
	out := make([]Field, len(fields))
	for i, fd := range fields {
		if err := checkField(fd); err != nil {
			return err
		}
		if names[fd.Name] {
			return core.Errorf(core.ErrInvalidInput, "duplicate field "+fd.Name)
		}
		names[fd.Name] = true
		out[i] = copyField(fd)
	}
	f.fields = out
	return nil
}

// Fields returns a copy of the schema.
func (f *Form) Fields() []Field {
	out := make([]Field, len(f.fields))
	for i, fd := range f.fields {
		out[i] = copyField(fd)
	}
	return out
}

// Normalize validates answers (one per field, in schema order) and returns
// their canonical form: integers are reformatted, absent optional answers
// are "".
func (f *Form) Normalize(answers []string) ([]string, error) {
	if len(answers) != len(f.fields) {
		return nil, core.Errorf(core.ErrInvalidInput, "expected "+strconv.Itoa(len(f.fields))+" answers")
	}
	out := make([]string, len(answers))
	total := 0
	for i, fd := range f.fields {
		a := answers[i]
		total += len(a)
		if a == "" {
			if fd.Required {
				return nil, core.Errorf(core.ErrInvalidInput, fd.Name+" is required")
			}
			continue
		}
		switch fd.Kind {
		case KindText:
			if err := core.CheckText(fd.Name, a, 1, fd.MaxBytes, fd.Multiline); err != nil {
				return nil, err
			}
			out[i] = a
		case KindInteger:
			n, err := strconv.ParseInt(a, 10, 64)
			if err != nil {
				return nil, core.Errorf(core.ErrInvalidInput, fd.Name+" must be an integer")
			}
			if n < fd.Min || n > fd.Max {
				return nil, core.Errorf(core.ErrInvalidInput, fd.Name+" out of range")
			}
			out[i] = strconv.FormatInt(n, 10)
		case KindChoice:
			if !contains(fd.Choices, a) {
				return nil, core.Errorf(core.ErrInvalidInput, fd.Name+" is not an allowed choice")
			}
			out[i] = a
		}
	}
	if total > f.cfg.MaxPayloadBytes {
		return nil, core.Errorf(core.ErrLimitExceeded, "answers too large")
	}
	return out, nil
}

// Submit stores a submission from submitter, who must be the authenticated
// caller.
func (f *Form) Submit(submitter address, answers []string) (uint64, error) {
	if !submitter.IsValid() {
		return 0, core.Errorf(core.ErrInvalidInput, "invalid submitter")
	}
	if f.subs.Size() >= f.cfg.MaxSubmissions {
		return 0, core.Errorf(core.ErrLimitExceeded, "form is full")
	}
	prev := f.submittedBy(submitter)
	if f.cfg.MaxPerSubmitter > 0 && prev >= f.cfg.MaxPerSubmitter {
		return 0, core.Errorf(core.ErrLimitExceeded, "submission limit reached for this address")
	}
	norm, err := f.Normalize(answers)
	if err != nil {
		return 0, err
	}
	f.nextID++
	id := f.nextID
	f.subs.Set(key(id), &submission{id: id, submitter: submitter, answers: norm, status: core.SubmissionSubmitted})
	f.perSubmitter.Set(submitter.String(), prev+1)
	f.byStatus[core.SubmissionSubmitted]++
	return id, nil
}

// Review moves a submitted entry to accepted or rejected. Decisions are
// final. The host must have authorized the reviewer.
func (f *Form) Review(id uint64, status core.SubmissionStatus) error {
	if status != core.SubmissionAccepted && status != core.SubmissionRejected {
		return core.Errorf(core.ErrInvalidInput, "review must accept or reject")
	}
	s := f.get(id)
	if s == nil {
		return core.Errorf(core.ErrNotFound, "submission")
	}
	if s.status != core.SubmissionSubmitted {
		return core.Errorf(core.ErrInvalidState, "submission already reviewed")
	}
	f.byStatus[s.status]--
	s.status = status
	f.byStatus[status]++
	return nil
}

// Submission implements core.SubmissionReader.
func (f *Form) Submission(id uint64) (core.SubmissionView, bool) {
	s := f.get(id)
	if s == nil {
		return core.SubmissionView{}, false
	}
	return s.view(), true
}

// Submissions implements core.SubmissionReader. status -1 returns all.
// Filtered paging scans at most the form's bounded submission count.
func (f *Form) Submissions(status int, offset, limit int) []core.SubmissionView {
	var out []core.SubmissionView
	if offset < 0 || limit <= 0 {
		return out
	}
	if status < 0 {
		f.subs.IterateByOffset(offset, limit, func(_ string, v any) bool {
			out = append(out, v.(*submission).view())
			return false
		})
		return out
	}
	skipped := 0
	f.subs.Iterate("", "", func(_ string, v any) bool {
		s := v.(*submission)
		if int(s.status) != status {
			return false
		}
		if skipped < offset {
			skipped++
			return false
		}
		out = append(out, s.view())
		return len(out) >= limit
	})
	return out
}

// Count implements core.SubmissionReader.
func (f *Form) Count() int { return f.subs.Size() }

// CountByStatus returns the number of submissions in status.
func (f *Form) CountByStatus(status core.SubmissionStatus) int {
	if status < 0 || int(status) >= len(f.byStatus) {
		return 0
	}
	return f.byStatus[status]
}

// SubmittedBy returns how many submissions addr has made.
func (f *Form) SubmittedBy(addr address) int { return f.submittedBy(addr) }

func (f *Form) submittedBy(addr address) int {
	v := f.perSubmitter.Get(addr.String())
	if v == nil {
		return 0
	}
	return v.(int)
}

func (f *Form) get(id uint64) *submission {
	v := f.subs.Get(key(id))
	if v == nil {
		return nil
	}
	return v.(*submission)
}

func (s *submission) view() core.SubmissionView {
	answers := make([]string, len(s.answers))
	copy(answers, s.answers)
	return core.SubmissionView{ID: s.id, Submitter: s.submitter, Answers: answers, Status: s.status}
}

func checkField(fd Field) error {
	if !isFieldName(fd.Name) {
		return core.Errorf(core.ErrInvalidInput, "invalid field name")
	}
	if err := core.CheckText("label", fd.Label, 1, 80, false); err != nil {
		return err
	}
	switch fd.Kind {
	case KindText:
		if fd.MaxBytes < 1 || fd.MaxBytes > HardMaxFieldBytes {
			return core.Errorf(core.ErrInvalidInput, fd.Name+": maxBytes out of range")
		}
	case KindInteger:
		if fd.Min > fd.Max {
			return core.Errorf(core.ErrInvalidInput, fd.Name+": min > max")
		}
	case KindChoice:
		if len(fd.Choices) < 2 || len(fd.Choices) > HardMaxChoices {
			return core.Errorf(core.ErrInvalidInput, fd.Name+": choice count out of range")
		}
		seen := map[string]bool{}
		for _, c := range fd.Choices {
			if err := core.CheckText("choice", c, 1, 80, false); err != nil {
				return err
			}
			if seen[c] {
				return core.Errorf(core.ErrInvalidInput, fd.Name+": duplicate choice")
			}
			seen[c] = true
		}
	default:
		return core.Errorf(core.ErrInvalidInput, fd.Name+": unknown kind")
	}
	return nil
}

func copyField(fd Field) Field {
	if fd.Choices != nil {
		c := make([]string, len(fd.Choices))
		copy(c, fd.Choices)
		fd.Choices = c
	}
	return fd
}

func isFieldName(s string) bool {
	if s == "" || len(s) > 32 {
		return false
	}
	for i, c := range s {
		if !((c >= 'a' && c <= 'z') || (i > 0 && ((c >= '0' && c <= '9') || c == '_'))) {
			return false
		}
	}
	return true
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func key(id uint64) string {
	s := strconv.FormatUint(id, 10)
	for len(s) < 20 {
		s = "0" + s
	}
	return s
}
