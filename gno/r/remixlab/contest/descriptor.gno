package contest

import "gno.land/p/remixlab/core/v1"

// configDigest is the canonical digest of the project configuration that
// produced this realm.
const configDigest = "sha256:71fde3abf5260a2e161e9bfb13033bba2e6bcf3be3c6e4410a10dcff70cc292c"

// Descriptor identifies this app's recipe and components.
func Descriptor() core.AppDescriptor {
	return core.AppDescriptor{
		Recipe:        recipeID,
		RecipeVersion: recipeVersion,
		Components: []string{
			"ballots@1.0.0",
			"core@1.0.0",
			"forms@1.0.0",
			"membership@1.0.0",
			"policies@1.0.0",
			"render@1.0.0",
		},
		ConfigDigest:      configDigest,
		ViewSchemaVersion: core.ViewSchemaVersion,
		Bindings:          []string{"membership.read/v1=" + pkgPath},
	}
}
