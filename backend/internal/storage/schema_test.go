package storage

import (
	"os"
	"strings"
	"testing"
)

// The SQL file is documentation, and documentation that silently drifts
// from the code is worse than none — someone reviewing the schema, or
// bootstrapping a database by hand, would be reading a lie. This test
// makes drift a build failure instead.
func TestMigrationFileMatchesSchema(t *testing.T) {
	raw, err := os.ReadFile("../../migrations/001_init.sql")
	if err != nil {
		t.Fatalf("read migration file: %v", err)
	}

	fromFile := parseSQLStatements(string(raw))
	if len(fromFile) != len(schemaStatements) {
		t.Fatalf("migrations/001_init.sql has %d statements, schema.go has %d — regenerate the file",
			len(fromFile), len(schemaStatements))
	}

	for i, want := range schemaStatements {
		if normalizeSQL(fromFile[i]) != normalizeSQL(want) {
			t.Fatalf("statement %d differs.\nfile:     %s\nschema.go: %s",
				i, normalizeSQL(fromFile[i]), normalizeSQL(want))
		}
	}
}

// parseSQLStatements splits on semicolons. Adequate because every
// statement in this file is plain DDL — no functions, no dollar-quoting,
// no semicolons inside literals or comments.
func parseSQLStatements(sql string) []string {
	out := []string{}
	for _, statement := range strings.Split(stripSQLComments(sql), ";") {
		if strings.TrimSpace(statement) != "" {
			out = append(out, statement)
		}
	}
	return out
}

// normalizeSQL reduces a statement to comparable DDL: comments removed,
// all whitespace collapsed. Both are needed — indentation differs between
// a Go raw string literal and a .sql file, and comments are prose that
// should be free to be reworded without failing a drift check.
func normalizeSQL(statement string) string {
	return strings.Join(strings.Fields(stripSQLComments(statement)), " ")
}

func stripSQLComments(sql string) string {
	var kept []string
	for _, line := range strings.Split(sql, "\n") {
		if index := strings.Index(line, "--"); index >= 0 {
			line = line[:index]
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}
