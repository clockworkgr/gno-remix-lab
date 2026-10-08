package clubpoll

import "gno.land/p/remixlab/core/v1"

// configDigest is the canonical digest of the project configuration that
// produced this realm.
const configDigest = "sha256:bf82a747d844a948b3c45d84bf7949bc33196ecedf7c660f8ce67bec62499047"

// Descriptor identifies this app's recipe and components.
func Descriptor() core.AppDescriptor {
	return core.AppDescriptor{
		Recipe:        recipeID,
		RecipeVersion: recipeVersion,
		Components: []string{
			"ballots@1.0.0",
			"core@1.0.0",
			"membership@1.0.0",
			"policies@1.0.0",
			"render@1.0.0",
		},
		ConfigDigest:      configDigest,
		ViewSchemaVersion: core.ViewSchemaVersion,
		Bindings:          []string{"membership.read/v1=" + pkgPath},
	}
}
