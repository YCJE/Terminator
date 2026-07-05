package migration

import (
	"database/sql"
	"embed"
	"errors"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/sqlite"
	"github.com/golang-migrate/migrate/v4/source/iofs"
)

//go:embed migrations/*.sql
var migrations embed.FS

func RunMigrations(db *sql.DB) error {
	sourceDriver, err := iofs.New(migrations, "migrations")
	if err != nil {
		return err
	}
	defer func() { _ = sourceDriver.Close() }()

	dbDriver, err := sqlite.WithInstance(db, &sqlite.Config{})
	if err != nil {
		return err
	}

	m, err := migrate.NewWithInstance("iofs", sourceDriver, "sqlite", dbDriver)
	if err != nil {
		return err
	}

	err = m.Up()
	if err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return err
	}

	return nil
}
