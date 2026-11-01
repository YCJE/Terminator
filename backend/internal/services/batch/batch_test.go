package batch

import (
	"strconv"
	"testing"
)

func TestNormalizeTimeout(t *testing.T) {
	cases := map[int]int{
		0:    defaultTimeoutSeconds,
		-5:   defaultTimeoutSeconds,
		30:   30,
		3601: maxTimeoutSeconds,
	}
	for input, want := range cases {
		if got := normalizeTimeout(input); got != want {
			t.Errorf("normalizeTimeout(%d) = %d，期望 %d", input, got, want)
		}
	}
}

func TestUniqueSessionIDs(t *testing.T) {
	got := uniqueSessionIDs([]string{"a", "", " a ", "b", "a", "  ", "c"})
	want := []string{"a", "b", "c"}
	if len(got) != len(want) {
		t.Fatalf("结果 = %v，期望 %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("结果 = %v，期望 %v", got, want)
		}
	}
}

func TestUniqueSessionIDsCapsLength(t *testing.T) {
	ids := make([]string, 0, maxSessions+10)
	for i := 0; i < maxSessions+10; i++ {
		ids = append(ids, "session-"+strconv.Itoa(i))
	}
	got := uniqueSessionIDs(ids)
	if len(got) != maxSessions {
		t.Fatalf("会话数 = %d，期望上限 %d", len(got), maxSessions)
	}
}
