// Consumer references a type from each colliding producer. Its generated module
// imports BOTH `FooBar_Alpha` and `FooBar_Beta` from "./FooBar.js" — but only one
// FooBar.ts survives the overwrite, so one import has no matching export.
import foo_bar.aleo;
import foo__bar.aleo;

program consumer.aleo {
    @noupgrade
    constructor() {}

    fn relay(a: foo_bar.aleo::Alpha, b: foo__bar.aleo::Beta) -> (foo_bar.aleo::Alpha, foo__bar.aleo::Beta) {
        return (a, b);
    }
}
