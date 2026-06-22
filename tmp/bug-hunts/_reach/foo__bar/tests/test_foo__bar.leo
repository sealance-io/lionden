// The 'test_foo__bar' test program.
import foo__bar.aleo;
program test_foo__bar.aleo {
    @test
    @should_fail
    fn test_main_fails() {
        let result: u32 = foo__bar.aleo::main(2u32, 3u32);
        assert_eq(result, 3u32);
    }

    @noupgrade
    constructor() {}
}
